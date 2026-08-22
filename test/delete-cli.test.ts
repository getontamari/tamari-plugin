import { describe, expect, it } from "vitest";

import { describeFailure, parseDeleteArgs } from "../skills/tamari/delete.mjs";

describe("delete CLI", () => {
  describe("arguments", () => {
    // Deletion is irreversible and retires the id. Requiring it to be typed is
    // the confirmation — a --yes flag would be one keystroke from the wrong app.
    it("requires the app id", () => {
      expect(parseDeleteArgs([], "ledger").error).toMatch(/required/i);
    });

    it("accepts an id matching the manifest", () => {
      expect(parseDeleteArgs(["ledger"], "ledger")).toEqual({ cmd: "delete", appId: "ledger" });
    });

    it("refuses an id that does not match the directory's app", () => {
      const parsed = parseDeleteArgs(["retro-board"], "ledger");
      expect(parsed.error).toContain("ledger");
      expect(parsed.cmd).toBeUndefined();
    });

    // The directory may be long gone — which is exactly when you most want to
    // delete the app.
    it("works with no manifest at all", () => {
      expect(parseDeleteArgs(["ledger"], null)).toEqual({ cmd: "delete", appId: "ledger" });
    });
  });

  describe("failures", () => {
    it("sends an unauthenticated caller to sign in", () => {
      expect(describeFailure(401, {}).code).toBe("not_signed_in");
    });

    // Not-found and not-yours answer identically, so the CLI must not invite
    // the agent to go hunting for ids it does not own.
    it("treats 403 and 404 the same", () => {
      expect(describeFailure(403, {}).code).toBe("app_not_found");
      expect(describeFailure(404, {}).code).toBe("app_not_found");
      expect(describeFailure(404, {}).message).toBe(describeFailure(403, {}).message);
    });

    it("names what survived a partial teardown, and says a retry is safe", () => {
      const { code, message } = describeFailure(502, { failed: ["database", "secrets"] });
      expect(code).toBe("delete_incomplete");
      expect(message).toContain("database, secrets");
      expect(message).toMatch(/safe to repeat/i);
      // The quota still counts it, and saying so stops the user assuming a slot
      // freed that did not.
      expect(message).toMatch(/quota/i);
    });

    it("falls back to the server's own message", () => {
      expect(describeFailure(500, { error: "boom" })).toEqual({
        code: "server_error",
        message: "boom",
      });
    });
  });
});
