// The logs CLI: the app's container log, from the terminal.
//
// The platform returns the newest entries of a bounded window and applies no
// filter of its own, so the filtering, ordering and — above all — the notes
// about what is *absent* are this plugin's job. Three wrong diagnoses were once
// built on lines missing from a view that could not have shown them.

import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SERVER_CAP,
  logNotes,
  parseLogsArgs,
  sanitizeLogText,
  selectEntries,
  sinceFrom,
} from "../skills/tamari/logs.mjs";

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);

describe("parseLogsArgs", () => {
  it("defaults to the last 50 lines of everything", () => {
    expect(parseLogsArgs([])).toEqual({ lines: 50, since: null, grep: null, severity: null, app: null });
  });
  it("accepts every filter, in either spelling", () => {
    expect(parseLogsArgs(["--lines", "5", "--since=15m", "--grep", "08P01", "--severity", "error", "--app", "birdwrangler"])).toEqual({
      lines: 5, since: "15m", grep: "08P01", severity: "ERROR", app: "birdwrangler",
    });
  });
  it("refuses what it cannot use, naming the flag", () => {
    expect(parseLogsArgs(["--lines", "0"])).toHaveProperty("error");
    expect(parseLogsArgs(["--lines", "abc"])).toHaveProperty("error");
    expect(parseLogsArgs(["--since", "yesterday"])).toHaveProperty("error");
    expect(parseLogsArgs(["--grep", "(["])).toHaveProperty("error");
    expect(parseLogsArgs(["--severity", "loud"])).toHaveProperty("error");
    expect(parseLogsArgs(["--app", "Not An Id"])).toHaveProperty("error");
    expect(parseLogsArgs(["--tail"])).toHaveProperty("error");
    expect(parseLogsArgs(["--lines"])).toHaveProperty("error");
  });
});

describe("sinceFrom", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  it("reads a duration back from now", () => {
    expect(sinceFrom("90s", now)).toBe(now - 90_000);
    expect(sinceFrom("15m", now)).toBe(now - 15 * 60_000);
    expect(sinceFrom("2h", now)).toBe(now - 2 * 3_600_000);
    expect(sinceFrom("1d", now)).toBe(now - 86_400_000);
  });
  it("reads an ISO timestamp, and rejects nonsense", () => {
    expect(sinceFrom("2026-09-02T11:00:00Z", now)).toBe(now - 3_600_000);
    expect(sinceFrom("soon", now)).toBeNull();
    expect(sinceFrom("", now)).toBeNull();
  });
});

describe("sanitizeLogText", () => {
  // A NUL in the app's output is the diagnosis (a `._` sidecar read as SQL),
  // so it stays visible; an escape sequence could rewrite the terminal, so it goes.
  it("keeps NUL bytes visible and flattens other control characters", () => {
    expect(sanitizeLogText(`on "${NUL}${NUL}Mac OS X"`)).toBe('on "\\0\\0Mac OS X"');
    expect(sanitizeLogText(`${ESC}[31mred${ESC}[0m`)).toBe(" [31mred [0m");
  });
  it("bounds the length", () => {
    expect(sanitizeLogText("x".repeat(5000)).length).toBe(2000);
    expect(sanitizeLogText(null)).toBe("");
  });
});

const entry = (timestamp: string, severity: string, text: string) => ({ timestamp, severity, text });
const newestFirst = [
  entry("2026-09-02T13:38:14Z", "ERROR", "Database open in 4049ms."),
  entry("2026-09-02T13:38:13Z", "ERROR", `08P01 invalid message format on "${NUL}Mac OS X"`),
  entry("2026-09-02T13:38:10Z", "INFO", "probe tcp=yes tls=yes auth=yes"),
  entry("2026-09-02T13:38:00Z", "DEFAULT", "listening on 8080"),
];

describe("selectEntries", () => {
  it("shows oldest first, so the log reads as a story", () => {
    expect(selectEntries(newestFirst).map((e) => e.text)).toEqual([
      "listening on 8080",
      "probe tcp=yes tls=yes auth=yes",
      '08P01 invalid message format on "\\0Mac OS X"',
      "Database open in 4049ms.",
    ]);
  });
  it("keeps the newest N when cutting", () => {
    expect(selectEntries(newestFirst, { lines: 2 }).map((e) => e.text)).toEqual([
      '08P01 invalid message format on "\\0Mac OS X"',
      "Database open in 4049ms.",
    ]);
  });
  it("filters by time, severity floor and pattern", () => {
    expect(selectEntries(newestFirst, { sinceMs: Date.parse("2026-09-02T13:38:12Z") })).toHaveLength(2);
    expect(selectEntries(newestFirst, { severity: "ERROR" })).toHaveLength(2);
    expect(selectEntries(newestFirst, { severity: "INFO" })).toHaveLength(3);
    expect(selectEntries(newestFirst, { grep: "08p01" })).toHaveLength(1);
  });
  it("normalises a missing severity to DEFAULT and drops malformed entries", () => {
    const out = selectEntries([{ timestamp: "2026-09-02T13:38:00Z", text: "plain" } as never, { timestamp: "x" } as never]);
    expect(out).toEqual([{ timestamp: "2026-09-02T13:38:00Z", severity: "DEFAULT", text: "plain" }]);
  });
});

describe("logNotes — what is absent", () => {
  const allErrors = [entry("2026-09-02T13:38:14Z", "ERROR", "a"), entry("2026-09-02T13:38:13Z", "ERROR", "b")];

  it("says the cap was hit, and that filters cannot reach past it", () => {
    const notes = logNotes({ returned: SERVER_CAP, shown: 50, entries: allErrors, windowHours: 24, opts: {} }).join("\n");
    expect(notes).toMatch(/maximum of 100/);
    expect(notes).toMatch(/do not reach further back/);
  });

  // The failure this tool exists for: every visible line was ERROR, so the
  // absence of the app's own console output meant nothing — and was read as
  // "the app never got there".
  it("warns that plain console output is not in an error-only view", () => {
    const notes = logNotes({ returned: 2, shown: 2, entries: allErrors, windowHours: 24, opts: {} }).join("\n");
    expect(notes).toMatch(/Every returned line is ERROR or above/);
    expect(notes).toMatch(/absent is unsafe/);
    expect(notes).toMatch(/"severity"/);
  });

  it("does not raise the severity warning when lower levels are present", () => {
    const notes = logNotes({ returned: 4, shown: 4, entries: newestFirst, windowHours: 24, opts: {} }).join("\n");
    expect(notes).not.toMatch(/Every returned line is ERROR/);
  });

  it("explains an empty window, including the sleeping-app case", () => {
    const notes = logNotes({ returned: 0, shown: 0, entries: [], windowHours: 24, opts: {} }).join("\n");
    expect(notes).toMatch(/No entries in the last 24 hours/);
    expect(notes).toMatch(/sleeps when idle/);
  });

  it("names the filter when it hid everything", () => {
    const notes = logNotes({ returned: 4, shown: 0, entries: newestFirst, windowHours: 24, opts: { grep: "nothing", severity: "ERROR" } }).join("\n");
    expect(notes).toMatch(/none matched --grep "nothing" --severity ERROR/);
  });

  it("points a NUL byte at the sidecar explanation", () => {
    const notes = logNotes({ returned: 4, shown: 4, entries: newestFirst, windowHours: 24, opts: {} }).join("\n");
    expect(notes).toMatch(/NUL bytes/);
    expect(notes).toMatch(/`\._name` sidecar/);
    expect(notes).toMatch(/skip dotfiles/);
  });
});

/**
 * End to end against a fake platform serving the real response shape:
 * `{ kind: "ok", windowHours, entries: [{ timestamp, severity, text }] }`,
 * newest first, no server-side filtering.
 */
describe("logs.mjs against a fake platform", () => {
  let api: Server | undefined;
  afterEach(() => api?.close());

  function fakePlatform(handler: (url: string) => { status: number; body: unknown }): Promise<number> {
    api = createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    return new Promise((resolve) => api!.listen(0, "127.0.0.1", () => resolve((api!.address() as { port: number }).port)));
  }

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "tamari-logs-"));
    writeFileSync(join(dir, "tamari.json"), JSON.stringify({ app: "birdwrangler", name: "B", runtime: "node", resourceClass: "personal", healthPath: "/healthz", requiresDatabase: true }));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  }

  function run(dir: string, port: number, args: string[] = []): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(process.cwd(), "skills/tamari/logs.mjs"), ...args], {
        cwd: dir,
        env: { ...process.env, TAMARI_API: `http://127.0.0.1:${port}`, TAMARI_TOKEN: "t" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("close", () => {
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`no JSON on stdout; stderr:\n${stderr}`)); }
      });
    });
  }

  it("reads the app from tamari.json, filters what the server returned, and carries the notes", async () => {
    let seenUrl = "";
    const port = await fakePlatform((url) => {
      seenUrl = url;
      return { status: 200, body: { kind: "ok", windowHours: 24, entries: newestFirst } };
    });
    const out = await run(repo(), port, ["--severity", "ERROR", "--lines", "1"]);
    expect(seenUrl).toBe("/api/apps/birdwrangler/logs");
    expect(out).toMatchObject({ ok: true, app: "birdwrangler", windowHours: 24, returned: 4, shown: 1 });
    expect((out.entries as { text: string }[])[0].text).toBe("Database open in 4049ms.");
    expect((out.notes as string[]).join("\n")).toMatch(/NUL bytes/);
  });

  it("names a missing app rather than reporting a generic failure", async () => {
    const port = await fakePlatform(() => ({ status: 404, body: { error: "not found" } }));
    const out = await run(repo(), port, ["--app", "gone"]);
    expect(out).toMatchObject({ ok: false, errorCode: "app_not_found" });
    expect(out.error).toMatch(/"gone"/);
  });

  it("maps a 401 to not_signed_in and a 5xx to server_error", async () => {
    const p401 = await fakePlatform(() => ({ status: 401, body: { error: "not signed in" } }));
    expect(await run(repo(), p401)).toMatchObject({ ok: false, errorCode: "not_signed_in" });
    api?.close();
    const p503 = await fakePlatform(() => ({ status: 503, body: { error: "down" } }));
    expect(await run(repo(), p503)).toMatchObject({ ok: false, errorCode: "server_error" });
  });

  it("reports a non-ok kind as the platform's problem, not the project's", async () => {
    const port = await fakePlatform(() => ({ status: 200, body: { kind: "backend_error", error: "logging backend timed out" } }));
    const out = await run(repo(), port);
    expect(out).toMatchObject({ ok: false, errorCode: "logs_unavailable" });
    expect(out.error).toMatch(/timed out/);
  });
});
