// @vitest-environment node
//
// Redeem: exchange a beta invite code for a deploy entitlement.

import { describe, expect, it } from "vitest";

import { parseRedeemArgs } from "../skills/tamari/redeem.mjs";

describe("parseRedeemArgs", () => {
  it("takes the first positional as the code", () => {
    expect(parseRedeemArgs(["sz_beta_abc"])).toEqual({ code: "sz_beta_abc" });
  });
  it("errors when no code is given", () => {
    expect(parseRedeemArgs([])).toEqual({ error: "usage: redeem <code>" });
  });
});
