#!/usr/bin/env node
// Tamari share: invite by email (viewer|editor), revoke access, or list who can
// reach an app. Wraps the real invitations + grants API; reads the app id from
// tamari.json. Revoke removes an active grant or, failing that, a pending invite.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { classifyApiFailure, resolveEndpoint, unreachable } from "./login.mjs";


function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function failWith({ errorCode, error }) { fail(errorCode, error); }
function fail(code, message) { out({ ok: false, errorCode: code, error: message }); process.exit(1); }

/** Parse argv (after the script name) into a command. Pure — unit-tested. */
export function parseShareArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "list") return { cmd: "list" };
  if (cmd === "invite") {
    const email = rest[0];
    const role = rest[1] ?? "editor";
    if (!email || !email.includes("@")) return { error: "usage: share invite <email> [viewer|editor]" };
    if (role !== "viewer" && role !== "editor") return { error: "role must be viewer or editor" };
    return { cmd: "invite", email, role };
  }
  if (cmd === "revoke") {
    const email = rest[0];
    if (!email || !email.includes("@")) return { error: "usage: share revoke <email>" };
    return { cmd: "revoke", email };
  }
  return { error: `unknown command: ${cmd ?? "(none)"} — use invite | revoke | list` };
}

/**
 * What to say when a re-invite killed the previous link. Pure — unit-tested.
 *
 * One live invitation per address is correct, but the owner has usually already
 * sent the first link by text or email, and this is the only moment anyone can
 * be told it just stopped working. The recipient is not told at all — nothing
 * emails invitations — so if the owner does not resend, the person they invited
 * is left with a link that reports "this invitation is not valid" and no way to
 * find out why.
 */
export function supersededNotice(superseded) {
  if (!superseded) return { superseded: false };
  return {
    superseded: true,
    warning:
      "This replaces an earlier invitation to the same address, and any link you already " +
      "sent them no longer works. Send them the new link — they will not be told automatically.",
  };
}

/** Which access record an email maps to, and its DELETE id. Pure — unit-tested. */
export function resolveRevokeTarget(access, email) {
  const norm = email.trim().toLowerCase();
  const grant = (access.grants ?? []).find((g) => g.email.toLowerCase() === norm);
  if (grant) return { kind: "grant", id: grant.userId };
  const invitation = (access.invitations ?? []).find((i) => i.email.toLowerCase() === norm);
  if (invitation) return { kind: "invitation", id: invitation.id };
  return { kind: "none", id: null };
}

async function jsonOf(res) { return res.json().catch(() => ({})); }

async function main() {
  const parsed = parseShareArgs(process.argv.slice(2));
  if ("error" in parsed) fail("bad_usage", parsed.error);

  // The endpoint and the credential are resolved together on purpose:
  // the stored token is bound to the default host.
  const { api: API, token, source } = resolveEndpoint(process.env, readFileSync);
  if (source === "refused") fail("credential_host_refused",
      `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`);
  if (!token) fail("not_signed_in", "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN).");

  const app = JSON.parse(readFileSync("tamari.json", "utf8")).app;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const base = `${API}/api/apps/${app}`;

  if (parsed.cmd === "invite") {
    const res = await fetch(`${base}/invitations`, {
      method: "POST", headers: auth, body: JSON.stringify({ email: parsed.email, role: parsed.role }),
    });
    const body = await jsonOf(res);
    if (!res.ok) failWith(classifyApiFailure(res.status, body));
    return out({
      ok: true,
      invited: parsed.email,
      role: parsed.role,
      inviteUrl: body.inviteUrl,
      expiresAt: body.expiresAt,
      ...supersededNotice(body.superseded),
    });
  }

  if (parsed.cmd === "list") {
    const res = await fetch(`${base}/invitations`, { headers: auth });
    const body = await jsonOf(res);
    if (!res.ok) failWith(classifyApiFailure(res.status, body));
    return out({ ok: true, grants: body.grants ?? [], invitations: body.invitations ?? [] });
  }

  // revoke: resolve the email against current access, then delete the right record.
  const listRes = await fetch(`${base}/invitations`, { headers: auth });
  const access = await jsonOf(listRes);
  if (!listRes.ok) failWith(classifyApiFailure(listRes.status, access));
  const target = resolveRevokeTarget(access, parsed.email);
  if (target.kind === "none") fail("not_found", `${parsed.email} has no access or pending invite to ${app}.`);
  const path = target.kind === "grant"
    ? `grants/${encodeURIComponent(target.id)}`
    : `invitations/${encodeURIComponent(target.id)}`;
  const res = await fetch(`${base}/${path}`, { method: "DELETE", headers: auth });
  const body = await jsonOf(res);
  if (!res.ok) failWith(classifyApiFailure(res.status, body));
  // The server answers { revoked: false } (still 200) when the record was
  // already gone — say so rather than claiming an action that did not happen.
  out({ ok: true, revoked: parsed.email, kind: target.kind, removed: body.revoked !== false });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.log(JSON.stringify(unreachable(resolveEndpoint(process.env, readFileSync).api, error), null, 2));
    process.exit(1);
  });
}
