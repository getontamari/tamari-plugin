#!/usr/bin/env node
// Tamari redeem: exchange a beta invite code for a deploy entitlement.
// Dynamic apps require an invite code or a card on file; static hosting is free.
//
//   node "$CLAUDE_PLUGIN_ROOT/skills/tamari/redeem.mjs" <code>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveEndpoint } from "./login.mjs";


function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

/** Parse argv (after the script name) into a redeem command. Pure — unit-tested. */
export function parseRedeemArgs(argv) {
  const [code] = argv;
  if (!code) return { error: "usage: redeem <code>" };
  return { code };
}

async function main() {
  const parsed = parseRedeemArgs(process.argv.slice(2));
  if ("error" in parsed) fail("bad_usage", parsed.error);

  // The endpoint and the credential are resolved together on purpose:
  // the stored token is bound to the default host.
  const { api: API, token, source } = resolveEndpoint(process.env, readFileSync);
  if (source === "refused") fail("credential_host_refused",
      `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`);
  if (!token) fail("not_signed_in", "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN).");

  const response = await fetch(`${API}/api/invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: parsed.code }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(body.errorCode ?? "error", body.error ?? `HTTP ${response.status}`);
  console.log(JSON.stringify({ ok: true, alreadyEntitled: body.alreadyEntitled === true }, null, 2));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail("error", error.message ?? String(error)));
}
