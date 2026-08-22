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
import { detectPersistence, readProject } from "./migrate-db.mjs";

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
 */
export function tarArgs(publishDir, archivePath) {
  return publishDir
    ? ["-czf", archivePath, "-C", publishDir, "."]
    : ["-czf", archivePath, "--null", "-T", "-"];
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

/** Human-readable byte size for status detail. Pure — unit-tested. */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)} ${units[i]}`;
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
  // its first nap is not deployed (see localDatabaseGuard).
  if (!publishDir) {
    let guard = null;
    try {
      guard = localDatabaseGuard(manifest, detectPersistence(readProject()));
    } catch {
      // Not a repository, or unreadable files: the upload below will say so.
    }
    if (guard) {
      console.log(JSON.stringify({ ok: false, ...guard }, null, 2));
      process.exit(1);
    }
  }

  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  // 1. Begin: validates the manifest and hands back a signed upload URL.
  const begun = await fetch(`${API}/api/deploy`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ manifest }),
  });
  const beginBody = await safeJson(begun);
  if (!begun.ok) {
    const { errorCode, error } = classifyFailure("deploy", begun.status, beginBody);
    fail(errorCode, error);
  }

  // 2. Upload the source. Tracked files only (never node_modules or .env) — or,
  //    for a static-export deploy, the built directory named by TAMARI_PUBLISH_DIR.
  if (publishDir) {
    execFileSync("tar", tarArgs(publishDir, ARCHIVE));
  } else {
    // -z gives NUL-delimited names with no quoting, which is what `tar --null`
    // expects. Never split this on a newline: a filename may contain one.
    const tracked = withoutDeleted(
      execFileSync("git", ["ls-files", "-z"]),
      execFileSync("git", ["ls-files", "-z", "--deleted"]),
    );
    if (tracked.length === 0) fail("no_files", "No git-tracked files to deploy.");
    execFileSync("tar", tarArgs(null, ARCHIVE), { input: tracked });
  }

  const uploadStart = Date.now();
  emitStage({ stage: "upload", status: "start" });
  const uploaded = await fetch(beginBody.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/gzip" },
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
      console.log(JSON.stringify({ ok: true, url: status.url, app: status.app, account }, null, 2));
      process.exit(0);
    }
    if (status.status === "failed") fail(status.errorCode ?? "build_failed", status.error);

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
