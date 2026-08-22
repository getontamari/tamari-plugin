import { describe, expect, it } from "vitest";
import { parseShareArgs, resolveRevokeTarget, supersededNotice } from "../skills/tamari/share.mjs";

describe("parseShareArgs", () => {
  it("invite defaults to editor", () => {
    expect(parseShareArgs(["invite", "sam@x.com"])).toEqual({ cmd: "invite", email: "sam@x.com", role: "editor" });
  });
  it("invite honours an explicit viewer role", () => {
    expect(parseShareArgs(["invite", "nan@x.com", "viewer"])).toEqual({ cmd: "invite", email: "nan@x.com", role: "viewer" });
  });
  it("rejects an unknown role", () => {
    expect(parseShareArgs(["invite", "a@x.com", "admin"]).error).toMatch(/viewer or editor/);
  });
  it("rejects a non-email", () => {
    expect(parseShareArgs(["invite", "notanemail"]).error).toMatch(/usage/);
  });
  it("parses revoke and list", () => {
    expect(parseShareArgs(["revoke", "sam@x.com"])).toEqual({ cmd: "revoke", email: "sam@x.com" });
    expect(parseShareArgs(["list"])).toEqual({ cmd: "list" });
  });
  it("reports an unknown command", () => {
    expect(parseShareArgs(["bogus"]).error).toMatch(/unknown/);
  });
});

describe("resolveRevokeTarget", () => {
  const access = {
    grants: [{ userId: "u1", email: "Sam@x.com", role: "editor" }],
    invitations: [{ id: "i1", email: "nan@x.com", role: "viewer" }],
  };
  it("matches an active grant case-insensitively", () => {
    expect(resolveRevokeTarget(access, "sam@x.com")).toEqual({ kind: "grant", id: "u1" });
  });
  it("matches a pending invitation", () => {
    expect(resolveRevokeTarget(access, "nan@x.com")).toEqual({ kind: "invitation", id: "i1" });
  });
  it("returns none when the email has neither", () => {
    expect(resolveRevokeTarget(access, "who@x.com")).toEqual({ kind: "none", id: null });
  });
});

/**
 * The agent renders whatever this returns, so the wording is the product
 * here — "superseded: true" on its own would be relayed as a shrug.
 */
describe("supersededNotice", () => {
  it("says nothing extra for a first invitation", () => {
    expect(supersededNotice(false)).toEqual({ superseded: false });
  });

  it("treats a response without the field as a first invitation", () => {
    expect(supersededNotice(undefined)).toEqual({ superseded: false });
  });

  it("says the link already sent is dead, and that nobody else will say so", () => {
    const notice = supersededNotice(true);
    if (!notice.superseded) throw new Error("expected a superseded notice");
    expect(notice.warning).toMatch(/no longer works/i);
    // The owner has to resend by hand — nothing emails invitations.
    expect(notice.warning).toMatch(/will not be told automatically/i);
  });
});
