// The error envelope every script shares, and the two failures that used to
// escape it: a 401 (mapped to `request_failed`/`error` by four scripts, so an
// expired credential never produced `not_signed_in`), and a network failure
// (a raw stack trace on stderr, nothing on stdout — nothing to branch on).

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyApiFailure, unreachable } from "../skills/tamari/login.mjs";

describe("classifyApiFailure", () => {
  it("maps every 401 to not_signed_in — the server sends no code on them", () => {
    expect(classifyApiFailure(401, { error: "not signed in" }).errorCode).toBe("not_signed_in");
    expect(classifyApiFailure(401, {}).errorCode).toBe("not_signed_in");
  });
  it("trusts a named code under either key the server uses", () => {
    expect(classifyApiFailure(409, { code: "static_app_has_no_runtime", error: "x" })).toEqual({ errorCode: "static_app_has_no_runtime", error: "x" });
    expect(classifyApiFailure(409, { errorCode: "already_subscribed", error: "y" }).errorCode).toBe("already_subscribed");
  });
  it("calls a 5xx the server's fault", () => {
    expect(classifyApiFailure(503, { error: "service unavailable" }).errorCode).toBe("server_error");
    expect(classifyApiFailure(502, null).errorCode).toBe("server_error");
  });
  it("reports an unnamed 4xx honestly, with the status", () => {
    const r = classifyApiFailure(404, { error: "not found" });
    expect(r.errorCode).toBe("request_failed");
    expect(r.error).toBe("not found (HTTP 404).");
  });
});

describe("unreachable", () => {
  it("names the host and the underlying cause", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
    const r = unreachable("http://127.0.0.1:9", e);
    expect(r).toMatchObject({ ok: false, errorCode: "unreachable" });
    expect(r.error).toContain("http://127.0.0.1:9");
    expect(r.error).toContain("bad port");
  });
});

/**
 * End to end, as the agent sees it: every script that talks to the API, run
 * against a port nothing listens on, must print a JSON envelope on stdout
 * with errorCode "unreachable" — never a bare stack trace.
 */
describe("a network failure reaches stdout as JSON", () => {
  const scripts = join(process.cwd(), "skills/tamari");
  const dir = mkdtempSync(join(tmpdir(), "tamari-unreachable-"));
  writeFileSync(join(dir, "tamari.json"), JSON.stringify({ app: "x", name: "X", runtime: "node", resourceClass: "personal", healthPath: "/healthz", requiresDatabase: false }));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  const env = { ...process.env, TAMARI_API: "http://127.0.0.1:9", TAMARI_TOKEN: "t", HOME: dir };

  it.each([
    ["deploy.mjs", []],
    ["status.mjs", []],
    ["share.mjs", ["list"]],
    ["secrets.mjs", ["list"]],
    ["delete.mjs", ["x"]],
    ["redeem.mjs", ["code"]],
    ["subscribe.mjs", []],
    ["login.mjs", []],
    ["logs.mjs", []],
  ])("%s", (script, args) => {
    const r = spawnSync(process.execPath, [join(scripts, script), ...args], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
    let parsed: { ok?: boolean; errorCode?: string } = {};
    expect(() => { parsed = JSON.parse(r.stdout); }, `stdout was not JSON:\n${r.stdout}\n${r.stderr}`).not.toThrow();
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode, r.stderr).toBe("unreachable");
    expect(r.stderr).not.toMatch(/at async|node:internal/);
  });
});
