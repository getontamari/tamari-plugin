#!/usr/bin/env node
// Tamari subscribe: open Stripe Checkout for a Personal or Pro plan.
// A paid plan grants dynamic-compute entitlement and the plan's app quotas.
//
//   node "$CLAUDE_PLUGIN_ROOT/skills/tamari/subscribe.mjs" [personal|pro]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveEndpoint } from "./login.mjs";


function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

/** Parse argv (after the script name) into a subscribe command. Pure — unit-tested. */
export function parseSubscribeArgs(argv) {
  const [plan = "personal"] = argv;
  if (plan !== "personal" && plan !== "pro") return { error: "usage: subscribe [personal|pro]" };
  return { plan };
}

async function main() {
  const parsed = parseSubscribeArgs(process.argv.slice(2));
  if ("error" in parsed) fail("bad_usage", parsed.error);

  // The endpoint and the credential are resolved together on purpose:
  // the stored token is bound to the default host.
  const { api: API, token, source } = resolveEndpoint(process.env, readFileSync);
  if (source === "refused") fail("credential_host_refused",
      `TAMARI_API points at ${API}, so the stored ~/.tamari credential was not sent — it is a full-account token and only travels to the default host. Set TAMARI_TOKEN as well to use another endpoint deliberately.`);
  if (!token) fail("not_signed_in", "Not signed in — run /tamari:deploy login (or set TAMARI_TOKEN).");

  const response = await fetch(`${API}/api/billing/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan: parsed.plan }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(body.errorCode ?? "error", body.error ?? `HTTP ${response.status}`);
  console.log(JSON.stringify({ ok: true, url: body.url }, null, 2));
  console.log(`\nOpen this URL to subscribe to the ${parsed.plan} plan:\n${body.url}`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail("error", error.message ?? String(error)));
}
