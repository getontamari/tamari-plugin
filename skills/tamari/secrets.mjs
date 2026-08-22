#!/usr/bin/env node
// Tamari secrets: set/list/unset per-app environment secrets. Secrets are
// encrypted at rest and injected as environment variables at deploy time — they
// never go in tamari.json, which is committed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveEndpoint } from "./login.mjs";


function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

const SET_USAGE =
  "usage: secrets set KEY --from-file <path> | --from-env <VAR> | --stdin";

/** The value of `--flag <v>` or `--flag=<v>`, or undefined. */
function flagValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Parse argv into a command. Pure — unit-tested.
 *
 * `set KEY=value` is deliberately **refused**. A secret in argv is
 * readable by any local user through `ps` or `/proc/<pid>/cmdline`, it lands in
 * shell history, and — because an agent runs these scripts through a shell tool
 * — the plaintext is captured in the session transcript and the model's
 * context. The first two are ordinary hygiene; the third is the one that cannot
 * be undone afterwards.
 *
 * So the value never travels as an argument. The agent passes a *reference* — a
 * file path or an environment variable name — and only the user's own process
 * ever holds the plaintext. `--stdin` covers piping from a password manager.
 */
export function parseSecretsArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "list") return { cmd: "list" };

  if (cmd === "unset") {
    const key = rest[0];
    if (!key) return { error: "usage: secrets unset KEY" };
    return { cmd: "unset", key };
  }

  if (cmd === "set") {
    const key = rest[0];
    if (!key) return { error: SET_USAGE };
    if (key.includes("=")) {
      return {
        error:
          `Refusing "KEY=value": a secret passed as an argument is visible to every ` +
          `process on this machine, is written to shell history, and is captured in ` +
          `the agent transcript. Pass a reference instead — ${SET_USAGE}`,
      };
    }
    const file = flagValue(rest, "--from-file");
    const env = flagValue(rest, "--from-env");
    const stdin = rest.includes("--stdin");
    const chosen = [file && "file", env && "env", stdin && "stdin"].filter(Boolean);
    if (chosen.length > 1) return { error: `Pick one source. ${SET_USAGE}` };
    if (file) return { cmd: "set", key, from: { kind: "file", path: file } };
    if (env) return { cmd: "set", key, from: { kind: "env", name: env } };
    if (stdin) return { cmd: "set", key, from: { kind: "stdin" } };
    return { error: SET_USAGE };
  }

  return { error: `unknown command: ${cmd ?? "(none)"} — use set | list | unset` };
}

/**
 * Read the secret from wherever the reference points. Pure given its deps.
 *
 * Returns the value or a typed failure; never throws with the value attached,
 * because an exception message is exactly the sort of thing that gets logged.
 */
export function readSecretValue(from, { readFile, env, readStdin }) {
  if (from.kind === "env") {
    const v = env[from.name];
    if (v === undefined) return { error: `$${from.name} is not set in this process.` };
    return { value: v };
  }
  if (from.kind === "file") {
    let raw;
    try {
      raw = readFile(from.path, "utf8");
    } catch {
      return { error: `Cannot read ${from.path}.` };
    }
    // One trailing newline is an artifact of how the file was written, not part
    // of the secret. Anything else is left alone — some keys legitimately end
    // in whitespace, and silently trimming them produces a value that fails
    // authentication somewhere far away with no clue why.
    return { value: raw.replace(/\n$/, "") };
  }
  const piped = readStdin();
  if (piped === null || piped === "") {
    return { error: "Nothing arrived on stdin. Pipe the value in, or use --from-file." };
  }
  return { value: piped.replace(/\n$/, "") };
}

async function main() {
  const parsed = parseSecretsArgs(process.argv.slice(2));
  if ("error" in parsed) fail("bad_usage", parsed.error);

  // The endpoint and the credential are resolved together on purpose:
  // the stored token is bound to the default host.
  const { api: API, token, source } = resolveEndpoint(process.env, readFileSync);
  if (source === "refused") fail("credential_host_refused",
      `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`);
  if (!token) fail("not_signed_in", "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN).");

  const manifest = JSON.parse(readFileSync("tamari.json", "utf8"));
  const app = manifest.app;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `${API}/api/apps/${app}/secrets`;

  let res;
  if (parsed.cmd === "set") {
    const read = readSecretValue(parsed.from, {
      readFile: readFileSync,
      env: process.env,
      readStdin: () => {
        try { return readFileSync(0, "utf8"); } catch { return null; }
      },
    });
    if (read.error) fail("secret_unreadable", read.error);
    res = await fetch(base, { method: "POST", headers: auth, body: JSON.stringify({ key: parsed.key, value: read.value }) });
  } else if (parsed.cmd === "list") {
    res = await fetch(base, { headers: auth });
  } else {
    res = await fetch(`${base}/${encodeURIComponent(parsed.key)}`, { method: "DELETE", headers: auth });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.code ?? "request_failed", body.error ?? `HTTP ${res.status}`);
  console.log(JSON.stringify({ ok: true, ...body }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
