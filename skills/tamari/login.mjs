#!/usr/bin/env node
// Tamari device sign-in for the skill. Two phases, because a blocking command
// hides its own output: `login.mjs` prints the URL and exits so the agent can
// show it; `login.mjs --wait` polls until the user approves.
//
// `--wait` is bounded and re-entrant rather than blocking for the code's whole
// lifetime. An agent runs it through a shell tool with a timeout of its own
// (two minutes by default) that shows the user nothing while it waits — so a
// ten-minute poll reads as a hang, and when the tool kills it the agent has to
// work out that nothing was lost. Returning `authorization_pending` after
// WAIT_MS and asking to be run again makes every call short and every outcome
// explicit.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_API = "https://ontamari.com";
const API = (process.env.TAMARI_API ?? "").trim() || DEFAULT_API;
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

/** How long one `--wait` call polls before handing control back. */
export const WAIT_MS = 90 * 1000;

/**
 * Poll until approval, failure, or `budgetMs` runs out. Pure given its deps —
 * unit-tested with a fake fetch and clock.
 *
 * Returns one of:
 *   { done: true, token, email }            approved
 *   { done: true, errorCode }               the server ended the flow
 *   { done: false, errorCode: "authorization_pending" }   budget spent; call again
 */
export async function pollUntil(fetchImpl, api, deviceCode, { budgetMs, intervalMs, now = Date.now, sleep }) {
  const deadline = now() + budgetMs;
  let waitMs = intervalMs;
  for (;;) {
    const r = await pollOnce(fetchImpl, api, deviceCode);
    if (r.done) return r;
    waitMs = r.retryAfterMs ?? waitMs;
    if (now() + waitMs > deadline) return { done: false, errorCode: "authorization_pending" };
    await sleep(waitMs);
  }
}

/**
 * The block the agent relays to the user, ready to paste. Pure — unit-tested.
 *
 * The agent sees this script's output; the user does not. A tool result is
 * shown to the model and, at most, a few lines of it to the person — so a URL
 * that is only ever in the JSON is a URL nobody opens, and the sign-in waits
 * forever for an approval the user was never asked for. Shipping the exact
 * text removes the step where the agent decides how much of that to mention.
 */
export function signInMessage({ url, userCode, expiresIn }) {
  const minutes = Math.max(1, Math.round((expiresIn ?? 600) / 60));
  return [
    "**Sign in to Tamari** — open this link on any device (this computer or your phone):",
    "",
    url,
    "",
    `1. Sign in, or sign up if you have no account.`,
    `2. Check the code on the page reads **${userCode}**.`,
    `3. Click **Approve**, then tell me you have done so.`,
    "",
    `The code expires in ${minutes} minutes.`,
  ].join("\n");
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
  const fields = { url: body.verificationUriComplete, userCode: body.userCode, expiresIn: body.expiresIn };
  const message = signInMessage(fields);
  // Also on stderr, unformatted, for a person running this by hand: the JSON
  // on stdout is for the agent.
  process.stderr.write(`\n${message.replace(/\*\*/g, "")}\n\n`);
  print({ ...fields, message });
}

async function wait() {
  let pending;
  try {
    pending = JSON.parse(readFileSync(PENDING, "utf8"));
  } catch {
    return print({ ok: false, errorCode: "no_pending_login", error: "No sign-in is in progress. Run login.mjs (without --wait) first." });
  }
  const { deviceCode, interval } = pending;
  const r = await pollUntil(fetch, API, deviceCode, {
    budgetMs: WAIT_MS,
    intervalMs: (interval ?? 5) * 1000,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  });
  if (r.done && r.token) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    // Record the email alongside the token — see cachedEmail.
    writeFileSync(CREDENTIAL, JSON.stringify({ token: r.token, email: r.email ?? null }), { mode: 0o600 });
    rmSync(PENDING, { force: true });
    return print({ ok: true, email: r.email });
  }
  if (r.done) {
    // The flow is over on the server, so the device code is dead either way.
    rmSync(PENDING, { force: true });
    return print({ ok: false, errorCode: r.errorCode, error: "Sign-in did not complete. Run login.mjs again for a fresh code." });
  }
  print({
    ok: false,
    errorCode: "authorization_pending",
    error: `Not approved yet after ${WAIT_MS / 1000}s. Ask the user to open the link and click Approve, then run this exact command again — nothing is lost between runs.`,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await (process.argv.includes("--wait") ? wait() : start());
}
