// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseSubscribeArgs } from "../skills/tamari/subscribe.mjs";

describe("parseSubscribeArgs", () => {
  it("defaults to the personal plan", () => {
    expect(parseSubscribeArgs([])).toEqual({ plan: "personal" });
  });
  it("takes personal or pro", () => {
    expect(parseSubscribeArgs(["pro"])).toEqual({ plan: "pro" });
    expect(parseSubscribeArgs(["personal"])).toEqual({ plan: "personal" });
  });
  it("rejects an unknown plan", () => {
    expect(parseSubscribeArgs(["enterprise"])).toEqual({ error: "usage: subscribe [personal|pro]" });
  });
});
