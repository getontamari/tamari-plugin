// The plugin's half of the error-code contract.
//
// The platform lives in a separate, private repository. Nothing connects the
// two codebases except this list, kept in both and asserted in both: a code the
// platform emits that this plugin does not document reaches an agent with no
// guidance attached, and a code documented here that the platform never sends
// is dead advice.
//
// The distinction being protected is not the wording. It is retry versus
// do-not-retry. Before the codes were separated by meaning, every failure
// arrived as one vague error and agents looped on server-side problems by
// rewriting projects that were already correct.
//
// Companion: the `errorCode` literals in `lib/deploy.ts`, `lib/build.ts` and
// `app/api/**` of the platform repository — there is no single file there yet.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Every code the platform can send that this plugin must act on. */
const PLATFORM_ERROR_CODES = [
  // The project's fault: fixable here, then redeploy.
  "always_on_slot_exceeded",
  "app_id_impersonation",
  "app_id_unavailable",
  "app_quota_exceeded",
  "build_failed",
  "build_script_failed",
  "build_timeout",
  "dependency_install_failed",
  "entitlement_required",
  "invalid_manifest",
  "revision_failed",
  "runtime_not_detected",
  "static_publish_failed",

  // Not the project's fault: editing files cannot help, a retry might.
  "app_unavailable",
  "build_submit_failed",
  "database_admission_denied",
  "database_provision_failed",
  "provision_failed",
  "secrets_decrypt_failed",
  "server_error",

  // Not the project's fault and not retryable: tell a human.
  "database_not_configured",

  // Credential state.
  "not_signed_in",
] as const;

const skill = readFileSync("skills/tamari/SKILL.md", "utf8");

describe("every platform error code is documented", () => {
  /**
   * The gap this was written for. `build_failed` — the catch-all when a build
   * log matches no known pattern — was emitted by the platform and used by
   * deploy.mjs as its fallback, while appearing nowhere in the failure table.
   * A build failing in an unrecognised way handed the agent a code with no
   * guidance, and it survived every review of that table because nothing
   * checked.
   */
  it.each(PLATFORM_ERROR_CODES)("%s appears in the failure table", (code) => {
    expect(skill).toContain(`\`${code}\``);
  });

  it("has codes to check, so an empty list cannot pass", () => {
    expect(PLATFORM_ERROR_CODES.length).toBeGreaterThan(15);
    expect(new Set(PLATFORM_ERROR_CODES).size).toBe(PLATFORM_ERROR_CODES.length);
  });

  /**
   * The table's value is the ruling, not the row. A code documented as "an
   * error occurred" is worse than absent — it looks handled.
   */
  it("keeps the not-the-project's-fault codes marked as such", () => {
    const table = skill.slice(skill.indexOf("| `errorCode`"));
    for (const code of ["server_error", "provision_failed", "build_submit_failed"]) {
      const row = table.split("\n").find((l) => l.includes(`\`${code}\``));
      expect(row, `no row for ${code}`).toBeDefined();
      expect(row).toMatch(/not the project|do not modify the project|report/i);
    }
  });

  it("tells the agent not to retry what cannot succeed", () => {
    const row = skill.split("\n").find((l) => l.includes("`database_not_configured`"));
    expect(row).toMatch(/do NOT retry|cannot succeed/i);
  });
});
