// `login.mjs --wait` runs inside an agent's shell tool, which has its own
// timeout and shows nothing while a command runs. A poll that lasts the device
// code's whole lifetime therefore looks like a hang and, when the tool kills
// it, leaves the agent unsure whether anything was lost. These tests pin the
// replacement: bounded, and re-entrant — a call that runs out of budget says
// so and can simply be run again.

import { describe, expect, it } from "vitest";

import { WAIT_MS, pollUntil, signInMessage } from "../skills/tamari/login.mjs";

/** A fake token endpoint that answers from a script, one body per call. */
function server(bodies: Array<{ status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string).deviceCode);
    const next = bodies.shift() ?? { status: 400, body: { error: "authorization_pending" } };
    return { ok: (next.status ?? 200) < 300, json: async () => next.body } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A clock that advances only when `sleep` is awaited. */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
}

const pending = { status: 400, body: { error: "authorization_pending" } };
const approved = { body: { token: "tok_1", email: "a@b.c" } };

describe("pollUntil", () => {
  it("returns the token as soon as the user approves", async () => {
    const { fetchImpl, calls } = server([pending, pending, approved]);
    const c = clock();
    const r = await pollUntil(fetchImpl, "https://x", "dc", { budgetMs: 60_000, intervalMs: 5_000, ...c });
    expect(r).toEqual({ done: true, token: "tok_1", email: "a@b.c" });
    expect(calls).toEqual(["dc", "dc", "dc"]);
    expect(c.slept).toEqual([5_000, 5_000]);
  });

  // The whole point: the budget, not the device code's lifetime, ends a call.
  it("gives up with authorization_pending when the budget runs out, without overshooting it", async () => {
    const { fetchImpl, calls } = server([]);
    const c = clock();
    const r = await pollUntil(fetchImpl, "https://x", "dc", { budgetMs: 12_000, intervalMs: 5_000, ...c });
    expect(r).toEqual({ done: false, errorCode: "authorization_pending" });
    // Polls at t=0, 5s, 10s; a fourth at 15s would exceed the budget, so it stops.
    expect(calls.length).toBe(3);
    expect(c.now()).toBeLessThanOrEqual(12_000);
  });

  it("passes a terminal server answer through unchanged", async () => {
    for (const error of ["expired_token", "access_denied"]) {
      const { fetchImpl } = server([pending, { status: 400, body: { error } }]);
      const r = await pollUntil(fetchImpl, "https://x", "dc", { budgetMs: 60_000, intervalMs: 5_000, ...clock() });
      expect(r).toEqual({ done: true, errorCode: error });
    }
  });

  it("backs off when told to slow down", async () => {
    const { fetchImpl } = server([{ status: 400, body: { error: "slow_down" } }, pending, approved]);
    const c = clock();
    await pollUntil(fetchImpl, "https://x", "dc", { budgetMs: 60_000, intervalMs: 1_000, ...c });
    expect(c.slept[0]).toBe(5_000);
  });

  // Below the shell tool's default two-minute timeout, with room for the
  // request itself, and well below the server's ten-minute code lifetime.
  it("defaults to a budget an agent's shell tool will not kill", () => {
    expect(WAIT_MS).toBeGreaterThanOrEqual(30_000);
    expect(WAIT_MS).toBeLessThan(120_000);
  });
});

// The user never sees tool output, so the link has to travel in a form the
// agent can paste whole. A URL that only exists in the JSON is never opened.
describe("signInMessage", () => {
  const msg = signInMessage({ url: "https://ontamari.com/link?code=ABCD-EFGH", userCode: "ABCD-EFGH", expiresIn: 600 });

  it("puts the link on its own line so every terminal makes it clickable", () => {
    expect(msg.split("\n")).toContain("https://ontamari.com/link?code=ABCD-EFGH");
  });

  it("names the code, the Approve step, and asks the user to report back", () => {
    expect(msg).toContain("ABCD-EFGH");
    expect(msg).toMatch(/Approve/);
    expect(msg).toMatch(/tell me/i);
    expect(msg).toMatch(/10 minutes/);
  });

  it("survives a missing expiry", () => {
    expect(signInMessage({ url: "u", userCode: "c" })).toMatch(/10 minutes/);
  });
});
