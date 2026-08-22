#!/usr/bin/env node
// Tamari delete: remove an app and everything it provisioned.
//
// Irreversible, and the app id is retired rather than freed — nobody, including
// you, can deploy to that hostname again. So the id has to be typed in full
// rather than read from tamari.json: this is the one command where "the app in
// this directory" is too easy to get wrong.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveEndpoint } from "./login.mjs";


function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function fail(code, message, extra = {}) {
  out({ ok: false, errorCode: code, error: message, ...extra });
  process.exit(1);
}

/**
 * Parse argv into a command. Pure — unit-tested.
 *
 * The confirmation is the app id itself. A `--yes` flag would be one keystroke
 * away from deleting the wrong app; typing the name means you looked at it.
 */
export function parseDeleteArgs(argv, manifestAppId) {
  const id = argv[0];
  if (!id) {
    return { error: "usage: delete <app-id> — the id is required, and must match tamari.json" };
  }
  if (manifestAppId && id !== manifestAppId) {
    return {
      error: `"${id}" does not match the app in this directory ("${manifestAppId}"). Run this from the app's own directory, or check the id.`,
    };
  }
  return { cmd: "delete", appId: id };
}

/** Turn the API's answer into something an agent can act on. Pure. */
export function describeFailure(status, body) {
  if (status === 401) return { code: "not_signed_in", message: "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN)." };
  if (status === 403 || status === 404) {
    // Not found and not yours answer identically, deliberately — the API will
    // not confirm an app id you do not own.
    return { code: "app_not_found", message: "No such app, or it is not yours to delete." };
  }
  if (status === 502) {
    return {
      code: "delete_incomplete",
      message: `Some resources could not be removed: ${(body.failed ?? []).join(", ") || "unknown"}. The app is still counted against your quota. Try again — this is safe to repeat.`,
    };
  }
  return { code: "server_error", message: body.error ?? `Delete failed (HTTP ${status}).` };
}

async function main() {
  // The endpoint and the credential are resolved together on purpose:
  // the stored token is bound to the default host.
  const { api: API, token, source } = resolveEndpoint(process.env, readFileSync);
  if (source === "refused") fail("credential_host_refused",
      `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`);
  if (!token) fail("not_signed_in", "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN).");

  let manifestAppId = null;
  try {
    manifestAppId = JSON.parse(readFileSync("tamari.json", "utf8")).app ?? null;
  } catch {
    // No manifest is fine: you may be deleting an app whose directory is long
    // gone, which is exactly when you most want this command.
  }

  const parsed = parseDeleteArgs(process.argv.slice(2), manifestAppId);
  if (parsed.error) fail("invalid_request", parsed.error);

  const res = await fetch(`${API}/api/apps/${encodeURIComponent(parsed.appId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const { code, message } = describeFailure(res.status, body);
    fail(code, message, body.failed ? { failed: body.failed } : {});
  }

  out({
    ok: true,
    deleted: parsed.appId,
    removed: body.removed ?? [],
    note: "The app id is retired — it cannot be deployed to again.",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail("server_error", error.message));
}
