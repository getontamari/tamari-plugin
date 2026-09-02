#!/usr/bin/env node
// Tamari deploy: package this directory, upload it, build, and report the URL.
//
// Deliberately plain: the agent reads this output, so every message is written
// to be acted on rather than admired.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cachedEmail, resolveEndpoint, unreachable } from "./login.mjs";
import { detectLocalWrites, detectPersistence, readProject } from "./migrate-db.mjs";
import { displayText } from "./status.mjs";

// Endpoint and credential resolved together — the stored token is bound
// to the default host, so a stray TAMARI_API cannot carry it off-platform.
const { api: API, token: TOKEN, source: TOKEN_SOURCE } = resolveEndpoint(process.env, readFileSync);

/**
 * A private directory for the source archive.
 *
 * `mkdtemp` rather than a fixed `/tmp/tamari-source.tgz`: on a shared host the
 * predictable name let anyone pre-plant a symlink to redirect the write, read
 * the archive — which contains every tracked file, including anything
 * committed by mistake — or collide with a concurrent deploy. `mkdtemp`
 * creates the directory 0700 and owned by us, atomically.
 */
const WORKDIR = mkdtempSync(join(tmpdir(), "tamari-"));
const ARCHIVE = join(WORKDIR, "source.tgz");

// Every exit path, including fail()'s process.exit(1). Synchronous because an
// exit handler cannot await, and best-effort because leaving a temp directory
// behind must never be the reason a deploy reports failure.
process.on("exit", () => {
  try { rmSync(WORKDIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

/** Parse a response body as JSON, tolerating an empty or non-JSON body (a 5xx
 *  from the platform, an XML error from storage). Never throws. */
async function safeJson(response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Map a failed HTTP response to an agent-actionable { errorCode, error }.
 *
 * The agent keys its next move on errorCode, so the mapping is load-bearing: a
 * code it recognises tells it what to change, but a 5xx or an auth failure is
 * NOT the project's fault. Those must surface honestly as `server_error` /
 * `not_signed_in` and never as `invalid_manifest`, which would send the agent to
 * rewrite a manifest that was never wrong and loop on a server-side problem.
 * `step` names the stage so an otherwise-unclassified 4xx is
 * still legible.
 */
export function classifyFailure(step, httpStatus, body) {
  // A manifest that failed validation comes back as a list of issues, no code.
  if (Array.isArray(body?.issues) && body.issues.length > 0) {
    return {
      errorCode: "invalid_manifest",
      error: body.issues.map((i) => `${i.field}: ${i.message}`).join("\n"),
    };
  }
  // The server named the problem: trust its code over any guess.
  if (body?.errorCode) {
    return { errorCode: body.errorCode, error: body.error ?? `HTTP ${httpStatus}` };
  }
  const serverMessage = body?.error;
  // Not signed in: a token problem, not a project problem.
  if (httpStatus === 401) {
    return {
      errorCode: "not_signed_in",
      error: serverMessage
        ? `Not signed in (HTTP 401): ${serverMessage}`
        : "Not signed in (HTTP 401). Check TAMARI_TOKEN.",
    };
  }
  // 5xx is Tamari's fault, never the caller's. Say so, so the agent stops rather
  // than editing files that are fine.
  if (httpStatus >= 500) {
    return {
      errorCode: "server_error",
      error: `Tamari returned HTTP ${httpStatus}${serverMessage ? `: ${serverMessage}` : ""}. This is a server-side problem — do not modify the project; report it and retry later.`,
    };
  }
  // Any other 4xx without a code: surface the status honestly rather than
  // inventing a specific cause.
  return {
    errorCode: `${step}_failed`,
    error: `${serverMessage ?? "Request failed"} (HTTP ${httpStatus}).`,
  };
}

/**
 * When a static-export build has produced `out/`, the deploy is static and
 * uploads that directory — not the tracked source. Static-ness is a property of
 * this deploy invocation, never written to tamari.json.
 */
export function manifestForDeploy(manifest, publishDir) {
  if (!publishDir) return manifest;
  return { ...manifest, runtime: "static", resourceClass: "static" };
}

/**
 * tar argv: the publish dir's contents when set, else the tracked file list
 * read from stdin.
 *
 * The tracked-file case does NOT put filenames in argv, and that is the whole
 * point. `tar` parses its own leading-dash arguments as options, so a
 * repository containing a file named `--use-compress-program=<cmd>` turned a
 * deploy into arbitrary command execution on the developer's machine — on GNU
 * tar, which is what Linux CI and devcontainers run. `execFileSync` prevented
 * *shell* injection and was never the relevant boundary.
 *
 * `--null -T -` reads NUL-delimited names from stdin, fed by `git ls-files -z`.
 * A `--` separator would have closed the injection too, but not the two bugs
 * beside it: `git ls-files` *quotes* names containing newlines, so splitting
 * its output on "\n" produced a path that does not exist and failed the deploy
 * — and a large repository can exceed ARGV_MAX. Reading from stdin makes all
 * three structurally impossible rather than escaped.
 *
 * `--no-xattrs` keeps macOS metadata out of the archive. Every file a Mac
 * has touched carries `com.apple.provenance` (and often `com.apple.quarantine`),
 * and tar records those as pax extended headers — `SCHILY.xattr.*` /
 * `LIBARCHIVE.xattr.*` — beside the file's entry. Nothing in `tar -t` shows
 * them, so an archive can be checked entry-by-entry and look clean while
 * still carrying them. An extractor that cannot store the attribute writes
 * it as an AppleDouble sidecar instead: `._001_init.sql` next to
 * `001_init.sql`, a few hundred bytes of `Mac OS X … ATTR` and NULs that ends
 * in `.sql`, sorts first, and gets sent to Postgres as a query by any app that
 * lists a directory by extension. That took a real app twelve deploys to find.
 * The attribute has no business in a deploy, so it is dropped at the source;
 * GNU tar (≥ 1.27) and bsdtar (≥ 3.1) both accept the flag, and `runTar`
 * retries without it for the one tar that does not (busybox).
 */
export function tarArgs(publishDir, archivePath, { xattrs = false } = {}) {
  const strip = xattrs ? [] : ["--no-xattrs"];
  return publishDir
    ? ["-czf", archivePath, ...strip, "-C", publishDir, "."]
    : ["-czf", archivePath, ...strip, "--null", "-T", "-"];
}

/**
 * The environment tar runs in. `COPYFILE_DISABLE=1` is the other half of the
 * xattr story on macOS: bsdtar honours it and skips the AppleDouble
 * (`._name`) entries it would otherwise synthesise for files with resource
 * forks or Finder metadata. Harmless everywhere else. Pure — unit-tested.
 */
export function tarEnv(env) {
  return { ...env, COPYFILE_DISABLE: "1" };
}

/**
 * The tracked files minus those deleted from the working tree. Pure — unit-tested.
 *
 * `git ls-files` lists what the index knows, including a file that has been
 * `rm`-ed but not yet `git rm`-ed — ordinary mid-refactor state. tar then
 * fails on "Cannot stat", which used to surface as a stack trace. Both inputs
 * are NUL-delimited (`-z`), for the reasons tarArgs gives.
 */
export function withoutDeleted(trackedZ, deletedZ) {
  const deleted = new Set(deletedZ.toString("utf8").split("\0").filter(Boolean));
  if (deleted.size === 0) return trackedZ;
  const kept = trackedZ.toString("utf8").split("\0").filter((p) => p && !deleted.has(p));
  return Buffer.from(kept.map((p) => `${p}\0`).join(""), "utf8");
}

/**
 * Refuse to ship data into a void. Pure — unit-tested.
 *
 * A container's filesystem lives exactly as long as that one instance, and a
 * personal-class app scales to zero when idle. An app that keeps its data in
 * a local SQLite file therefore loses everything the first time it sleeps —
 * which is what happened to the first real app deployed with this plugin:
 * deploy reported ✓, the user entered data, the instance was retired, the
 * next one booted with the empty file from the image.
 *
 * The detection already existed in migrate-db.mjs and the skill already said
 * "never silently ship an app that depends on a local SQLite file" — but that
 * was a separate step the agent could skip, and it was skipped. So the deploy
 * itself now checks. The user said "deploy this" and still gets a URL; the
 * agent just does the migration first. `"persistence": "ephemeral"` in
 * tamari.json is the deliberate opt-out for a scratch database.
 *
 * Data already in the local file is not the plugin's concern: it is not
 * copied, not warned about, and not blocked on. If the user wants it moved,
 * they will ask, and the agent can do that then.
 */
export function localDatabaseGuard(manifest, detection) {
  if (manifest.runtime === "static") return null;
  if (manifest.requiresDatabase === true) return null;
  if (manifest.persistence === "ephemeral") return null;
  const matches = detection?.matches ?? [];
  if (matches.length === 0) return null;

  const frameworks = matches.map((m) => m.framework);
  const auto = matches.filter((m) => m.action === "auto");
  const manual = matches.filter((m) => m.action === "warn");
  const nextSteps = [];
  if (auto.length > 0) {
    nextSteps.push(
      `Run migrate-db.mjs — it rewires ${auto.map((m) => m.framework).join(", ")} to the injected Postgres DATABASE_URL automatically and sets requiresDatabase.`,
    );
  }
  for (const m of manual) {
    nextSteps.push(`Port ${m.framework} (${m.files.join(", ")}) to Postgres yourself:`);
    for (const step of m.nextSteps ?? []) nextSteps.push(`  - ${step}`);
  }
  nextSteps.push('Then set "requiresDatabase": true in tamari.json (migrate-db.mjs does this when it applies an edit) and redeploy.');
  nextSteps.push('Only if the user genuinely wants a throwaway database: set "persistence": "ephemeral" in tamari.json to deploy as-is.');

  return {
    errorCode: "local_database_detected",
    error:
      `This app keeps its data in a local database file (${frameworks.join(", ")}), and "requiresDatabase" is false. ` +
      "A container's disk is wiped every time the app sleeps, so every row the user enters would be lost. " +
      "Not deployed. Move the app to the managed Postgres first — the steps are in nextSteps — then redeploy.",
    frameworks,
    files: [...new Set(matches.flatMap((m) => m.files))],
    nextSteps,
  };
}

/**
 * Refuse to ship an npm lockfile the builder cannot install. Pure — unit-tested.
 *
 * npm records a native package's platform variants as `optionalDependencies`
 * and installs the matching one. A long-standing npm bug (npm/cli#4828) makes
 * an incremental `npm install` — node_modules already present — record only
 * the current platform's variant in package-lock.json. Apps are scaffolded on
 * ARM Macs; the builder is linux-x64 and installs strictly from the lockfile
 * (`npm ci`), so the Linux binary never lands and the build dies the first
 * time it is required — a ~90-second cloud round trip to learn what this check
 * says before anything leaves the machine. The platform classifies that same
 * build failure under the same code; the remediation is identical either way.
 *
 * The check: every name any entry declares in `optionalDependencies` must be
 * recorded somewhere in the `packages` map. A healthy lockfile records every
 * variant and lets `npm ci` skip the foreign ones, so a declared name with no
 * entry can never install anywhere. Missing Linux x64 names refuse the deploy;
 * gaps for other platforms only get a note — this build does not need them,
 * but a collaborator's `npm ci` on one of those platforms will.
 *
 * By global name, not resolution position: a nested copy pinned to one
 * platform whose variants are recorded only on another copy's path would slip
 * through. That narrower shape has not failed a real build; this catches the
 * class that has.
 */
export function lockfilePlatformPreflight(lock, lockfileName = "package-lock.json") {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") return null; // v1, or not an npm lockfile
  const recorded = new Set();
  for (const key of Object.keys(packages)) {
    const at = key.lastIndexOf("node_modules/");
    if (at !== -1) recorded.add(key.slice(at + "node_modules/".length));
  }
  const missing = new Set();
  for (const entry of Object.values(packages)) {
    for (const name of Object.keys(entry?.optionalDependencies ?? {})) {
      if (!recorded.has(name)) missing.add(name);
    }
  }
  if (missing.size === 0) return null;

  // The builder: linux, x64, glibc. Naming varies by family — `-linux-x64-gnu`
  // (napi-rs), `-linux-x64` (esbuild, sharp), `-linux-64` (workerd),
  // `-linux-x64-glibc` (parcel) — and `linux-arm64` must not match.
  const buildPlatform = (name) => /linux[-_](x64|amd64|64)([-_](gnu|musl|glibc))?$/.test(name);
  const failing = [...missing].filter(buildPlatform).sort();
  const other = [...missing].filter((n) => !buildPlatform(n)).sort();

  if (failing.length === 0) {
    const sample = other.slice(0, 6).join(", ") + (other.length > 6 ? ` and ${other.length - 6} more` : "");
    return {
      note:
        `${lockfileName} declares optional platform packages it never records (${sample}). ` +
        "This Linux x64 build does not need them, but an install on those platforms will fail — " +
        `regenerating the lockfile (delete node_modules and ${lockfileName}, run \`npm install\`, commit) closes the gap.`,
    };
  }
  return {
    fail: {
      errorCode: "lockfile_platform_mismatch",
      error:
        `Your ${lockfileName} was generated on another platform and is missing Linux native packages ` +
        "(npm optional-dependencies bug, npm/cli#4828). Not uploaded: the builder installs strictly from " +
        `this lockfile, so the build would fail on the first missing binary. Delete node_modules (including ` +
        `any workspace node_modules) and ${lockfileName}, run \`npm install\`, commit the regenerated ` +
        "lockfile, and redeploy.",
      missing: failing,
      ...(other.length > 0 ? { alsoMissingOtherPlatforms: other } : {}),
      nextSteps: [
        `Delete node_modules — every workspace's too — and ${lockfileName}.`,
        "Run `npm install` on any platform; a full resolve records every platform's packages.",
        `Check the regenerated ${lockfileName} has entries for: ${failing.join(", ")}.`,
        "Commit the lockfile and redeploy.",
      ],
    },
  };
}

/**
 * Refuse an archive the platform would reject on arrival. Pure — unit-tested.
 *
 * The begin response names the upload limit, and storage enforces it with a
 * signed header this client sends back. Checking the archive here first turns
 * storage's bare 400 into the cause and the fix: only git-tracked files are
 * packaged (or the export directory, for a static publish), so an archive
 * over the limit means something large is tracked by mistake — build output,
 * media, vendored dependencies. No limit named means nothing to check.
 */
export function archiveTooLarge(bytes, limit, kind) {
  if (!Number.isFinite(limit) || limit <= 0 || bytes <= limit) return null;
  const mib = (n) => Math.ceil(n / (1024 * 1024));
  const tracked = kind !== "publishDir";
  return {
    errorCode: "source_too_large",
    error:
      `The source archive is ${mib(bytes)} MiB; the limit is ${mib(limit)} MiB. Not uploaded. ` +
      (tracked
        ? "Only git-tracked files are packaged, so something large is tracked by mistake — build output, " +
          "media, or vendored dependencies. Untrack it (add it to .gitignore, then `git rm -r --cached`), commit, and redeploy."
        : "The export directory is packaged as-is, so it holds something large — media or generated files. " +
          "Remove them from the export (or exclude them from the build), rebuild, and redeploy."),
    bytes,
    limit,
    nextSteps: tracked
      ? [
          "Find what is large: `git ls-files -z | xargs -0 du -k | sort -n | tail`.",
          "Untrack build output, media and vendored dependencies: add them to .gitignore and `git rm -r --cached <path>`.",
          "Commit and redeploy.",
        ]
      : [
          "Find what is large in the export directory: `du -ak <dir> | sort -n | tail`.",
          "Remove large media or generated files from the export, or exclude them from the build.",
          "Rebuild and redeploy.",
        ],
  };
}

/** Human-readable byte size for status detail. Pure — unit-tested. */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * A platform failure at startup, named for what it is. Pure — unit-tested.
 *
 * The platform's startup check is a TCP probe on $PORT. When it fails the
 * platform has reported the failure under `provision_failed` with the raw
 * message ("STARTUP TCP probe failed … The instance was not started", or
 * "never reported a URI"), and the failure table files `provision_failed`
 * under "not the project's fault — do not modify the project". For a port
 * that never opened that ruling is exactly backwards: the process was
 * started and did not listen in time, which is the project's startup path.
 * An agent that trusted the table lost three deploys retrying a bug it had
 * been told not to fix. The message pattern is the truth here, so the code
 * follows it, and the fix the message never mentions is attached.
 */
const STARTUP_PROBE_FAILED =
  /STARTUP (?:TCP|HTTP) probe failed|never reported a URI|instance was not started|failed to start and listen on the port|container failed to start/i;

export function classifyDeployFailure(errorCode, message) {
  const text = typeof message === "string" ? message : "";
  if (STARTUP_PROBE_FAILED.test(text)) {
    return {
      errorCode: "revision_failed",
      error:
        `${text}\n\n` +
        "The platform's startup check is a TCP probe on $PORT, and the port never opened in time. " +
        "The most common cause is awaiting a database connection (or any other async setup) before app.listen(): " +
        "bind PORT first, on 0.0.0.0, and connect afterwards. Binding 127.0.0.1 fails the same way — the probe " +
        "arrives from outside the container.",
    };
  }
  return { errorCode: errorCode ?? "build_failed", error: message };
}

/**
 * What one GET of the health path after go-live says about the app. Pure —
 * unit-tested.
 *
 * `startup ok` fires when the platform's TCP probe passes, and an app that
 * binds before it connects passes that probe with a database it cannot
 * reach. Twelve consecutive deploys reported `startup ok` while every request
 * to the app failed. This request is the first one that reaches the app's own
 * code, so it is the first line of output that can tell "port open" from
 * "working". The gateway serves the health path without a session so the
 * wake check can reach it, which means no credential travels to the app.
 */
export function healthOutcome(path, status, bodyText) {
  const body = displayText(bodyText ?? "", 300);
  if (status === 200) return { path, status, body, ok: true };
  const answered = status == null ? "did not answer" : `answered ${status}`;
  return {
    path,
    status,
    body,
    ok: false,
    warning:
      `The app is live but GET ${path} ${answered}, not 200. The platform's startup check only saw the port open; ` +
      "this was the first request to reach the app itself. Read the body and the container log (logs.mjs) before " +
      "calling this deploy working. After the app sleeps, the wake check needs this path to answer 200 — while it " +
      "does not, every wake fails and the app is unreachable.",
  };
}

async function probeHealth(url, path, fetchImpl = fetch) {
  const target = new URL(path, url).toString();
  try {
    const res = await fetchImpl(target, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return healthOutcome(path, res.status, await res.text().catch(() => ""));
  } catch (error) {
    return healthOutcome(path, null, error?.cause?.message ?? error?.message ?? String(error));
  }
}

/**
 * The note for an app that writes files to its own disk. Pure — unit-tested.
 *
 * Advisory, not a refusal: the same calls write build output and temp files,
 * and only the author knows which writes are user data. The database guard
 * above catches the file that holds every row; this catches the uploads
 * directory beside it, which is wiped on the same schedule and which no
 * detector mentioned when a real app shipped its photos to disk.
 */
export function localWritesNote(manifest, writes) {
  if (manifest.runtime === "static") return null;
  const files = writes?.files ?? [];
  if (files.length === 0) return null;
  const named = files.slice(0, 6).map((f) => `${f.path} (${f.pattern})`).join(", ") + (files.length > 6 ? ` and ${files.length - 6} more` : "");
  return (
    `This app writes to its own disk: ${named}. The container's filesystem is wiped every time the app sleeps ` +
    "and Tamari injects DATABASE_URL and no blob store, so anything users upload or the app generates there is " +
    "lost on the first nap. If these writes are user data (uploads, generated media), store the bytes in Postgres " +
    "(a bytea column) or an external bucket instead. Build output and temp files are fine as they are."
  );
}

/** Which stage a deployment status belongs to (for failure attribution). */
const STAGE_OF_STATUS = { queued: "queue", building: "build", deploying: "provision", verifying: "startup" };

/**
 * Client-observable stage events for a status transition prev -> next.
 * `runtime` distinguishes the static fast-path (queued -> live) from the
 * dynamic path (queued -> building -> deploying -> live). Pure — unit tested.
 * Emits only stages the client can actually see; no fabricated substeps.
 */
export function stageEvents(prev, next, runtime) {
  if (prev === next) return [];
  if (next === "failed") return [{ stage: STAGE_OF_STATUS[prev] ?? "deploy", status: "fail" }];
  if (next === "building") return [{ stage: "build", status: "start" }];
  if (next === "deploying") {
    return [{ stage: "build", status: "ok" }, { stage: "provision", status: "start" }];
  }
  if (next === "verifying") {
    // The service exists; the platform is waiting for the new revision
    // to pass its startup probe before calling the deploy live.
    return [{ stage: "provision", status: "ok" }, { stage: "startup", status: "start" }];
  }
  if (next === "live") {
    if (runtime === "static") return [{ stage: "publish", status: "ok" }, { stage: "live", status: "ok" }];
    if (prev === "verifying") return [{ stage: "startup", status: "ok" }, { stage: "live", status: "ok" }];
    if (prev === "deploying") return [{ stage: "provision", status: "ok" }, { stage: "live", status: "ok" }];
    return [{ stage: "live", status: "ok" }];
  }
  return [];
}

function emitStage(ev, extra) {
  process.stderr.write(JSON.stringify({ t: "stage", stage: ev.stage, status: ev.status, ...extra }) + "\n");
}

/**
 * Package the archive without macOS metadata (see tarArgs). A tar that does
 * not know `--no-xattrs` — busybox, in a minimal container — exits non-zero
 * before reading any input, so the retry is safe; the note tells the agent the
 * archive may carry the attributes and what that means for the deployed tree.
 */
function runTar(publishDir, input) {
  const opts = { env: tarEnv(process.env), ...(input ? { input } : {}), stdio: ["pipe", "pipe", "pipe"] };
  try {
    execFileSync("tar", tarArgs(publishDir, ARCHIVE), opts);
  } catch (error) {
    const stderr = error?.stderr?.toString?.("utf8") ?? "";
    if (!/no-xattrs|unrecognized|unknown option|invalid option/i.test(stderr)) throw error;
    execFileSync("tar", tarArgs(publishDir, ARCHIVE, { xattrs: true }), opts);
    process.stderr.write(JSON.stringify({
      t: "note",
      note: "This tar does not support --no-xattrs, so the archive may carry macOS extended attributes; the deployed tree can then contain `._name` sidecar files beside your own. Any code that lists a directory by extension must skip dotfiles.",
    }) + "\n");
  }
}

async function main() {
  if (!existsSync("tamari.json")) fail("no_manifest", "tamari.json is missing. Create it first.");
  if (TOKEN_SOURCE === "refused") {
    fail("credential_host_refused",
      `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`);
  }
  if (!TOKEN) fail("not_signed_in", "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN).");

  const publishDir = process.env.TAMARI_PUBLISH_DIR;
  if (publishDir && !existsSync(publishDir)) {
    fail("no_publish_dir", `TAMARI_PUBLISH_DIR is set to "${publishDir}" but that directory does not exist. Run the build first.`);
  }
  const manifest = manifestForDeploy(JSON.parse(readFileSync("tamari.json", "utf8")), publishDir);

  // Before anything leaves the machine: an app whose data would not survive
  // its first nap is not deployed (see localDatabaseGuard), and an app that
  // writes files to its own disk is told so (see localWritesNote).
  if (!publishDir) {
    let guard = null;
    let writes = null;
    try {
      const project = readProject();
      guard = localDatabaseGuard(manifest, detectPersistence(project));
      writes = localWritesNote(manifest, detectLocalWrites(project));
    } catch {
      // Not a repository, or unreadable files: the upload below will say so.
    }
    if (guard) {
      console.log(JSON.stringify({ ok: false, ...guard }, null, 2));
      process.exit(1);
    }
    if (writes) process.stderr.write(JSON.stringify({ t: "note", note: writes }) + "\n");
  }

  // Same doctrine, different defect: a node build installs exactly what the
  // committed npm lockfile records, and a lockfile grown incrementally on a
  // mac records no Linux natives (npm/cli#4828). Milliseconds here beat ~90
  // seconds of cloud build arriving at the same message (see
  // lockfilePlatformPreflight). Only the tracked lockfile counts — an ignored
  // one never reaches the builder.
  if (!publishDir && manifest.runtime === "node") {
    let preflight = null;
    try {
      const tracked = execFileSync("git", ["ls-files", "-z", "--", "npm-shrinkwrap.json", "package-lock.json"])
        .toString("utf8").split("\0").filter(Boolean);
      // npm prefers the shrinkwrap when both ship.
      const lockfile = ["npm-shrinkwrap.json", "package-lock.json"].find((f) => tracked.includes(f));
      if (lockfile) preflight = lockfilePlatformPreflight(JSON.parse(readFileSync(lockfile, "utf8")), lockfile);
    } catch {
      // Not a repository, or an unparseable lockfile: the build will say so with more authority.
    }
    if (preflight?.fail) {
      console.log(JSON.stringify({ ok: false, ...preflight.fail }, null, 2));
      process.exit(1);
    }
    if (preflight?.note) {
      process.stderr.write(JSON.stringify({ t: "note", note: preflight.note }) + "\n");
    }
  }

  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  // 1. Begin: validates the manifest and hands back a signed upload URL.
  //    `uploadLimit` says this client will send the size header the platform
  //    signs into that URL, so storage refuses an oversized upload outright.
  const begun = await fetch(`${API}/api/deploy`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ manifest, uploadLimit: true }),
  });
  const beginBody = await safeJson(begun);
  if (!begun.ok) {
    const { errorCode, error } = classifyFailure("deploy", begun.status, beginBody);
    fail(errorCode, error);
  }

  // 2. Upload the source. Tracked files only (never node_modules or .env) — or,
  //    for a static-export deploy, the built directory named by TAMARI_PUBLISH_DIR.
  if (publishDir) {
    runTar(publishDir, undefined);
  } else {
    // -z gives NUL-delimited names with no quoting, which is what `tar --null`
    // expects. Never split this on a newline: a filename may contain one.
    const tracked = withoutDeleted(
      execFileSync("git", ["ls-files", "-z"]),
      execFileSync("git", ["ls-files", "-z", "--deleted"]),
    );
    if (tracked.length === 0) fail("no_files", "No git-tracked files to deploy.");
    runTar(null, tracked);
  }

  // Over the platform's limit: say why here, before the upload storage
  // would refuse with a bare 400 (see archiveTooLarge).
  const tooLarge = archiveTooLarge(statSync(ARCHIVE).size, beginBody.uploadLimitBytes, publishDir ? "publishDir" : "tracked");
  if (tooLarge) {
    console.log(JSON.stringify({ ok: false, ...tooLarge }, null, 2));
    process.exit(1);
  }

  const uploadStart = Date.now();
  emitStage({ stage: "upload", status: "start" });
  // `uploadHeaders` are the headers the platform signed into the URL — the
  // size limit today. Storage rejects the PUT if a signed header is missing,
  // so they are sent back exactly as given.
  const uploaded = await fetch(beginBody.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/gzip", ...(beginBody.uploadHeaders ?? {}) },
    body: readFileSync(ARCHIVE),
  });
  if (!uploaded.ok) {
    // A storage PUT returns XML, not our JSON, so there is no server code here —
    // classify on status alone.
    const { errorCode, error } = classifyFailure("upload", uploaded.status, null);
    fail(errorCode, error);
  }
  let uploadDetail;
  try { uploadDetail = humanBytes(statSync(ARCHIVE).size); } catch { uploadDetail = undefined; }
  emitStage({ stage: "upload", status: "ok" }, { ms: Date.now() - uploadStart, ...(uploadDetail ? { detail: uploadDetail } : {}) });

  // 3. Build.
  const started = await fetch(`${API}/api/deployments/${beginBody.deploymentId}/start`, {
    method: "POST",
    headers: auth,
  });
  if (!started.ok) {
    const { errorCode, error } = classifyFailure("start", started.status, await safeJson(started));
    fail(errorCode, error);
  }

  // 4. Poll. Polling is what advances the deployment, so this is not just waiting.
  const deadline = Date.now() + 15 * 60 * 1000;
  let prevStatus = "queued";
  const stageStart = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${API}/api/deployments/${beginBody.deploymentId}`, {
      headers: auth,
    });
    const status = await safeJson(response);
    if (!response.ok) {
      const { errorCode, error } = classifyFailure("poll", response.status, status);
      fail(errorCode, error);
    }

    if (status.status !== prevStatus) {
      for (const ev of stageEvents(prevStatus, status.status, manifest.runtime)) {
        const extra = {};
        if (ev.status === "start") stageStart[ev.stage] = Date.now();
        if ((ev.status === "ok" || ev.status === "fail") && stageStart[ev.stage]) {
          extra.ms = Date.now() - stageStart[ev.stage];
        }
        if (ev.stage === "build" && ev.status === "ok") extra.detail = `buildpack · ${manifest.runtime}`;
        if (ev.stage === "provision" && ev.status === "ok") extra.detail = manifest.requiresDatabase ? "database + service" : "service";
        if (ev.stage === "publish" && ev.status === "ok") extra.detail = "static bundle";
        if (ev.stage === "live" && status.url) extra.detail = status.url;
        emitStage(ev, extra);
      }
      prevStatus = status.status;
    }

    if (status.status === "live") {
      // The account is on every success on purpose. "I deployed but my
      // launcher is empty" is a phone signed into a different account, and it
      // is indistinguishable from a broken deploy unless the terminal says
      // whose app this just became. Cached, so it costs no round trip and is
      // absent (rather than wrong) when TAMARI_TOKEN is in play.
      const account = cachedEmail(process.env, readFileSync);

      // The platform's startup check saw a port. This request is the first
      // to reach the app's own code (see healthOutcome). Static sites have
      // no code to reach and no health path to speak of.
      let health = null;
      if (status.url && manifest.runtime !== "static" && typeof manifest.healthPath === "string" && manifest.healthPath.startsWith("/")) {
        const probeStart = Date.now();
        health = await probeHealth(status.url, manifest.healthPath);
        emitStage(
          { stage: "health", status: health.ok ? "ok" : "fail" },
          { ms: Date.now() - probeStart, detail: `GET ${health.path} → ${health.status ?? "no answer"}` },
        );
      }
      console.log(JSON.stringify({
        ok: true,
        url: status.url,
        app: status.app,
        account,
        ...(health ? { health } : {}),
        ...(health && !health.ok ? { warning: health.warning } : {}),
      }, null, 2));
      process.exit(0);
    }
    if (status.status === "failed") {
      // A startup probe that never saw the port open is the project's fault
      // whatever code it arrived under (see classifyDeployFailure).
      const { errorCode, error } = classifyDeployFailure(status.errorCode, status.error);
      fail(errorCode, error);
    }

    await new Promise((r) => setTimeout(r, 5000));
  }
  fail("timeout", "Deployment did not finish within 15 minutes.");
}

// Run only as the CLI, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((error) => {
    console.log(JSON.stringify(unreachable(API, error), null, 2));
    process.exit(1);
  });
}
