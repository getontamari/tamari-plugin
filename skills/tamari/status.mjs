#!/usr/bin/env node
// Tamari status: who this machine is signed in as, what plan that account is
// on, how much of its app quota is spent, and what the apps are.
//
// Before this existed the only way to learn your quota was to hit
// `app_quota_exceeded` mid-deploy, and there was no way at all to learn which
// account held the token — so a terminal signed into one account and a phone
// signed into another looked exactly like an app that failed to deploy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cachedEmail, resolveEndpoint } from "./login.mjs";


function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function fail(obj) { out({ ok: false, ...obj }); process.exit(1); }

const PLAN_LABEL = { free: "free", personal: "personal", pro: "pro" };

/**
 * Make a server-provided string safe to *display*. Pure — unit-tested.
 *
 * Some of what this output carries is written by other people. An app someone
 * shares with you brings their `name` and their email along, and both land in
 * the JSON a coding agent reads. That is a channel from one tenant into another
 * tenant's agent context, and it needs no compromised server to use — just a
 * neighbour who names an app after an instruction.
 *
 * The server bounds `name` at 60 characters and rejects control characters, so
 * this is the second layer rather than the only one. It exists because the
 * plugin cannot verify that the server enforced anything, and because a client
 * that only behaves when the server behaves is not a boundary at all.
 *
 * Stripping control characters also removes ANSI escapes, which could otherwise
 * rewrite a terminal's display of what it just printed.
 */
export function displayText(value, max = 120) {
  if (typeof value !== "string") return "";
  const flattened = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

/**
 * "3 of 10 apps" — the sentence the user actually wanted. Pure.
 *
 * Being *over* the limit needs different phrasing, not just different
 * pluralisation: on Free the cap is one, and "3 of 1 app" is not a sentence.
 * That state is reachable without doing anything strange — apps that predate a
 * cap, or a plan that lapsed back to Free — and it is exactly when someone is
 * most likely to be reading this line to work out what went wrong.
 */
export function quotaLine(usage) {
  const { apps, appLimit } = usage;
  if (apps > appLimit) {
    return `${apps} apps, over a limit of ${appLimit}`;
  }
  return `${apps} of ${appLimit} app${appLimit === 1 ? "" : "s"}`;
}

/**
 * Shape `/api/me` into what the agent should say. Pure — unit-tested.
 *
 * Two things this is careful about, both of which a walkthrough of the product
 * got wrong when a human tried to answer them from the docs:
 *
 * - **Static apps count.** "Static sites are free" is true about *billing* and
 *   false about the *app limit*, and the docs' phrasing reads as though a
 *   static site is outside the quota. The platform counts it, so whenever one
 *   is on the account, say so rather than leaving the
 *   arithmetic to be discovered at the wrong moment.
 * - **An app being deleted still occupies its slot** until teardown finishes,
 *   so it is listed. Without that line the total looks wrong by one.
 */
export function summarizeAccount(payload) {
  const usage = payload.usage;
  const apps = (payload.apps ?? []).map((a) => ({
    id: a.id,
    name: displayText(a.name),
    runtime: a.runtime,
    state: a.state,
    url: a.url,
  }));

  const notes = [];
  if (apps.some((a) => a.runtime === "static")) {
    notes.push("Static apps are free to run, but they still count toward the app limit.");
  }
  if (apps.some((a) => a.state === "deleting")) {
    notes.push("An app still being deleted keeps its slot until teardown finishes.");
  }
  if (usage.apps >= usage.appLimit) {
    notes.push("At the app limit — the next new app will be refused. Delete one, or upgrade.");
  }
  if (!payload.entitled) {
    notes.push("This account cannot deploy dynamic apps yet — static sites only, until an invite is redeemed or a plan is bought.");
  }

  /**
   * Credentials about to lapse — and only ever *other* credentials.
   *
   * A deploy token expires after a period of disuse, so the one making this
   * request can never be close: asking refreshed its clock a moment ago.
   * Warning about it would be nonsense dressed as diligence. What can quietly
   * stop working is the token on another machine, or in CI, that nobody has
   * used lately — and the first sign of that is otherwise a failed deploy.
   */
  const idleDays = payload.idleDays ?? 90;
  const lapsing = (payload.credentials ?? [])
    .filter((c) => !c.current && c.daysLeft <= 14)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  for (const c of lapsing) {
    const when = c.daysLeft === 0 ? "today" : `in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}`;
    notes.push(
      `The credential "${displayText(c.name, 60)}" (${c.prefix}…) stops working ${when} — ` +
        `tokens lapse after ${idleDays} days unused. Using it resets that; signing in ` +
        `again on that machine replaces it.`,
    );
  }

  return {
    ok: true,
    account: payload.user.email,
    plan: PLAN_LABEL[payload.plan.key] ?? payload.plan.key,
    planStatus: payload.plan.status,
    quota: quotaLine(usage),
    atLimit: usage.apps >= usage.appLimit,
    entitled: payload.entitled,
    alwaysOn: usage.alwaysOnSlots > 0 ? `${usage.alwaysOn} of ${usage.alwaysOnSlots}` : null,
    apps,
    // Written by whoever owns the app, not by us. Everything a neighbour
    // controls is flattened before it reaches the agent.
    credentials: (payload.credentials ?? []).map((c) => ({
      name: displayText(c.name, 60),
      prefix: c.prefix,
      lastUsedAt: c.lastUsedAt,
      daysLeft: c.daysLeft,
      current: c.current,
    })),
    sharedWithMe: (payload.sharedWithMe ?? []).map((a) => ({
      ...a,
      name: displayText(a.name),
      ownerEmail: displayText(a.ownerEmail, 254),
    })),
    notes,
  };
}

async function main() {
  // The endpoint and the credential are resolved together on purpose:
  // the stored token is bound to the default host.
  const { api: API, token, source } = resolveEndpoint(process.env, readFileSync);
  if (source === "refused") {
    return fail({
      errorCode: "credential_host_refused",
      error: `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`,
    });
  }
  const hint = cachedEmail(process.env, readFileSync);
  if (!token) {
    return fail({
      errorCode: "not_signed_in",
      error: "This machine is not signed in to Tamari.",
    });
  }

  let res;
  try {
    res = await fetch(`${API}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    // Offline. The cached email is the best available answer and is labelled
    // as unconfirmed — it is what the machine last signed in as, not proof of
    // what the token is worth now.
    return fail({
      errorCode: "unreachable",
      error: `Could not reach ${API}: ${e.message}`,
      lastKnownAccount: hint,
    });
  }

  if (res.status === 401) {
    // The case that matters most: a revoked token still sitting in a shell
    // profile. Reporting the cached email here would confirm an identity this
    // machine no longer has, so it is named as former, not current.
    return fail({
      errorCode: "token_invalid",
      error: "The stored credential is no longer valid — sign in again.",
      formerAccount: hint,
    });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail({ errorCode: body.code ?? "request_failed", error: body.error ?? `HTTP ${res.status}` });
  out(summarizeAccount(body));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
