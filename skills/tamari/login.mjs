#!/usr/bin/env node
// Tamari device sign-in for the skill. Two phases, because a blocking command
// hides its own output: `login.mjs` prints the URL and exits so the agent can
// show it; `login.mjs --wait` polls until the user approves.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_API = "https://ontamari.com";
const API = process.env.TAMARI_API ?? DEFAULT_API;
const DIR = join(homedir(), ".tamari");
const CREDENTIAL = join(DIR, "credentials.json");
const PENDING = join(DIR, "pending-login.json");

export function credentialPath() { return CREDENTIAL; }

/** TAMARI_TOKEN (env, wins for CI) then the credential file. */
export function resolveToken(env, readFile) {
  if (env.TAMARI_TOKEN) return env.TAMARI_TOKEN;
  try {
    return JSON.parse(readFile(CREDENTIAL, "utf8")).token ?? null;
  } catch {
    return null;
  }
}

/** Same origin, ignoring a trailing slash, default port or case. */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false; // unparseable is not the default origin — fail closed
  }
}

/**
 * Where to talk, and what credential may be sent there.
 *
 * The stored `~/.tamari` token is a **full-account** credential — deploy,
 * delete, secrets, billing — it is long-lived, and it was previously attached
 * as `Authorization: Bearer` to whatever `TAMARI_API` happened to say. Anything
 * that could set one environment variable could therefore collect it: a repo's
 * `.envrc` under direnv, or prompt-injected text in a `CLAUDE.md` or README
 * persuading the agent to export it. The victim need only run a deploy in a
 * directory someone else wrote.
 *
 * So the two are resolved together, and the on-disk credential is bound to the
 * default origin. Pointing elsewhere is still supported — that is how CI and
 * staging work — but it requires `TAMARI_TOKEN`, which is a deliberate act by
 * whoever set it rather than something a stray variable can arrange.
 *
 * Failing closed on an unparseable `TAMARI_API` is deliberate: a value that is
 * not a URL is not the default origin, and guessing what was meant is how a
 * guard like this gets bypassed.
 */
export function resolveEndpoint(env, readFile) {
  const configured = (env.TAMARI_API ?? "").trim();
  const api = configured || DEFAULT_API;
  const isDefault = !configured || sameOrigin(api, DEFAULT_API);

  if (env.TAMARI_TOKEN) return { api, token: env.TAMARI_TOKEN, source: "env" };
  if (!isDefault) return { api, token: null, source: "refused" };

  const token = resolveToken(env, readFile);
  return { api, token, source: token ? "file" : "none" };
}

/**
 * The account this machine last signed in as — a hint, never proof.
 *
 * The device flow already knows the email; it used to print it and throw it
 * away. Keeping it makes "who am I signed in as?" answerable offline, which is
 * the question behind the most likely support ticket this product will get
 * ("I deployed but my launcher is empty" — two different accounts).
 *
 * Deliberately null when TAMARI_TOKEN is set: the env token may belong to an
 * entirely different account from the one in the file, and reporting the
 * file's email for someone else's token would confirm the wrong answer to the
 * exact question being asked. Older credential files have no email at all, so
 * null is also the normal answer until the next sign-in.
 */
export function cachedEmail(env, readFile) {
  if (env.TAMARI_TOKEN) return null;
  try {
    return JSON.parse(readFile(CREDENTIAL, "utf8")).email ?? null;
  } catch {
    return null;
  }
}

/** One poll of the token endpoint → a normalised outcome. */
export async function pollOnce(fetchImpl, api, deviceCode) {
  const res = await fetchImpl(`${api}/api/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.token) return { done: true, token: body.token, email: body.email };
  if (body.error === "authorization_pending") return { done: false };
  if (body.error === "slow_down") return { done: false, retryAfterMs: 5000 };
  return { done: true, errorCode: body.error ?? "login_failed" };
}

function print(obj) { console.log(JSON.stringify(obj, null, 2)); }

async function start() {
  const res = await fetch(`${API}/api/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientName: `Claude Code on ${hostname()}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return print({ ok: false, errorCode: body.error ?? "start_failed" });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PENDING, JSON.stringify({ deviceCode: body.deviceCode, interval: body.interval }), { mode: 0o600 });
  print({ url: body.verificationUriComplete, userCode: body.userCode, expiresIn: body.expiresIn });
}

async function wait() {
  const { deviceCode, interval } = JSON.parse(readFileSync(PENDING, "utf8"));
  const deadline = Date.now() + 15 * 60 * 1000;
  let waitMs = (interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    const r = await pollOnce(fetch, API, deviceCode);
    if (r.done && r.token) {
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      // Record the email alongside the token — see cachedEmail.
      writeFileSync(CREDENTIAL, JSON.stringify({ token: r.token, email: r.email ?? null }), { mode: 0o600 });
      return print({ ok: true, email: r.email });
    }
    if (r.done) return print({ ok: false, errorCode: r.errorCode });
    waitMs = r.retryAfterMs ?? waitMs;
    await new Promise((res) => setTimeout(res, waitMs));
  }
  print({ ok: false, errorCode: "expired_token" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await (process.argv.includes("--wait") ? wait() : start());
}
