// The db-check CLI: the probes that separate "the URL connects" from "the app
// will work". PGlite is not the wire, so the driver behaviours below were first
// met in production by a real port. The probe runner is pure over a client, so
// it is exercised here with a stub that behaves like a real Postgres — and with
// one that behaves like PGlite, to prove the warnings fire.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyConnectError,
  loadPg,
  parseDbCheckArgs,
  redactDatabaseUrl,
  runProbes,
  type ProbeClient,
} from "../skills/tamari/db-check.mjs";

const NUL = String.fromCharCode(0);

describe("parseDbCheckArgs", () => {
  it("defaults to $DATABASE_URL and takes the URL by reference", () => {
    expect(parseDbCheckArgs([])).toEqual({ from: { kind: "env", name: "DATABASE_URL" } });
    expect(parseDbCheckArgs(["--from-env", "PROD_DB"])).toEqual({ from: { kind: "env", name: "PROD_DB" } });
    expect(parseDbCheckArgs(["--from-file=/tmp/url"])).toEqual({ from: { kind: "file", path: "/tmp/url" } });
  });
  // Same doctrine as secrets.mjs: an argument is in `ps`, history and the transcript.
  it("refuses a URL as an argument, without echoing it", () => {
    const r = parseDbCheckArgs(["postgres://u:hunter2@host/db"]) as { error: string };
    expect(r.error).toMatch(/shell history|transcript/);
    expect(r.error).not.toContain("hunter2");
  });
  it("rejects unknown flags and missing values", () => {
    expect(parseDbCheckArgs(["--url", "x"])).toHaveProperty("error");
    expect(parseDbCheckArgs(["--from-file"])).toHaveProperty("error");
  });
});

describe("redactDatabaseUrl", () => {
  it("hides the password and nothing else", () => {
    expect(redactDatabaseUrl("postgres://app:s3cret@10.20.0.3:5432/app_x?sslmode=no-verify")).toBe("postgres://app:***@10.20.0.3:5432/app_x?sslmode=no-verify");
    expect(redactDatabaseUrl("postgres://app@host/db")).toBe("postgres://app@host/db");
    expect(redactDatabaseUrl("not a url")).toBe("<unparseable database URL>");
  });
});

describe("classifyConnectError", () => {
  it("names the stage that failed", () => {
    expect(classifyConnectError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).stage).toBe("tcp");
    expect(classifyConnectError(new Error("timeout expired")).stage).toBe("tcp");
    expect(classifyConnectError(Object.assign(new Error("self signed certificate"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })).stage).toBe("tls");
    expect(classifyConnectError(Object.assign(new Error("password authentication failed"), { code: "28P01" })).stage).toBe("auth");
    expect(classifyConnectError(Object.assign(new Error("database does not exist"), { code: "3D000" })).stage).toBe("database");
  });
  it("tells the reader the provisioned database is private, on a tcp failure", () => {
    expect(classifyConnectError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).hint).toMatch(/private network|tunnel/);
  });
});

/** A stub with real-Postgres behaviour: errors carry SQLSTATE codes, BIGINT is a string, bytea is a Buffer, NUL is refused, transactions abort. */
function postgresLike(over: Partial<{ bigintAsNumber: boolean; byteaAsUint8: boolean; acceptNul: boolean; noAbort: boolean; ipkAssigns: boolean }> = {}): ProbeClient {
  let inTx = false;
  let aborted = false;
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });
  return {
    async query(text, params) {
      if (inTx && aborted && !/^ROLLBACK/.test(text)) throw err("25P02", "current transaction is aborted");
      if (text === "BEGIN") { inTx = true; aborted = false; return { rows: [] }; }
      if (text === "ROLLBACK") { inTx = false; aborted = false; return { rows: [] }; }
      if (/current_setting\('server_version'\)/.test(text)) return { rows: [{ v: "17.10" }] };
      if (/\$1::text AS t, \$2::int AS n/.test(text)) return { rows: [{ t: params![0], n: params![1] }] };
      if (/COUNT\(\*\) AS n/.test(text)) return { rows: [{ n: over.bigintAsNumber ? 2 : "2" }] };
      if (/SUM\(x\) AS s/.test(text)) return { rows: [{ s: "3" }] };
      if (/decode\('00ff', 'hex'\)/.test(text)) return { rows: [{ b: over.byteaAsUint8 ? new Uint8Array([0, 255]) : Buffer.from([0, 255]) }] };
      if (/\$1::text AS t$/.test(text)) {
        if (String(params![0]).includes(NUL) && !over.acceptNul) throw err("22021", "invalid byte sequence for encoding UTF8: 0x00");
        return { rows: [{ t: params![0] }] };
      }
      if (/SELECT 1\/0/.test(text)) { if (inTx && !over.noAbort) aborted = true; throw err("22012", "division by zero"); }
      if (text === "SELECT 1") return { rows: [{ "?column?": 1 }] };
      if (/CREATE TEMP TABLE/.test(text)) return { rows: [] };
      if (/INSERT INTO tamari_db_check_ipk/.test(text)) { if (over.ipkAssigns) return { rows: [] }; throw err("23502", 'null value in column "id" violates not-null constraint'); }
      if (/DROP TABLE/.test(text)) return { rows: [] };
      if (/repeat\('x', 200000\)/.test(text)) return { rows: [{ n: "200000" }] };
      throw err("42601", `unexpected query in stub: ${text}`);
    },
  };
}

describe("runProbes", () => {
  it("against real-Postgres behaviour: warns on the string types, confirms the rest", async () => {
    const results = await runProbes(postgresLike());
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.server_version).toMatchObject({ status: "ok", detail: "PostgreSQL 17.10" });
    expect(byName.extended_query_non_ascii.status).toBe("ok");
    expect(byName.bigint_type).toMatchObject({ status: "warn" });
    expect(byName.bigint_type.detail).toMatch(/setTypeParser\(20, Number\)/);
    expect(byName.numeric_type).toMatchObject({ status: "warn" });
    expect(byName.bytea_type).toMatchObject({ status: "ok" });
    expect(byName.nul_in_parameter).toMatchObject({ status: "ok" });
    expect(byName.nul_in_parameter.detail).toMatch(/22021/);
    expect(byName.transaction_abort).toMatchObject({ status: "ok" });
    expect(byName.transaction_abort.detail).toMatch(/25P02/);
    expect(byName.integer_primary_key_assigns_nothing).toMatchObject({ status: "ok" });
    expect(byName.integer_primary_key_assigns_nothing.detail).toMatch(/GENERATED BY DEFAULT AS IDENTITY/);
    expect(byName.large_result.status).toBe("ok");
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
  });

  // PGlite-shaped: this is exactly what the app's tests see, and why the
  // production failures were a surprise.
  it("against PGlite-like behaviour: flags Uint8Array bytea, accepted NULs, non-aborting transactions", async () => {
    const results = await runProbes(postgresLike({ bigintAsNumber: true, byteaAsUint8: true, acceptNul: true, noAbort: true, ipkAssigns: true }));
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.bigint_type.status).toBe("ok");
    expect(byName.bytea_type).toMatchObject({ status: "warn" });
    expect(byName.bytea_type.detail).toMatch(/Buffer\.from/);
    expect(byName.nul_in_parameter.status).toBe("warn");
    expect(byName.transaction_abort.status).toBe("warn");
    expect(byName.integer_primary_key_assigns_nothing.status).toBe("warn");
  });

  it("reports an unexpected error as a failed probe with its code, and keeps going", async () => {
    const broken: ProbeClient = {
      async query(text) {
        if (/server_version/.test(text)) throw Object.assign(new Error("permission denied"), { code: "42501" });
        return postgresLike().query(text);
      },
    };
    const results = await runProbes(broken);
    expect(results[0]).toMatchObject({ name: "server_version", status: "fail", code: "42501" });
    expect(results.length).toBeGreaterThan(5);
  });
});

describe("db-check.mjs as a CLI", () => {
  const script = join(process.cwd(), "skills/tamari/db-check.mjs");
  const dir = mkdtempSync(join(tmpdir(), "tamari-dbcheck-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true }));
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, DATABASE_URL: "", ...env }, encoding: "utf8", timeout: 20_000 });
    return JSON.parse(r.stdout) as { ok: boolean; errorCode: string; error: string };
  };

  it("says when there is no URL to check", () => {
    expect(run([])).toMatchObject({ ok: false, errorCode: "database_url_unreadable" });
    expect(run(["--from-file", join(dir, "nope")])).toMatchObject({ ok: false, errorCode: "database_url_unreadable" });
  });

  it("refuses a URL argument and never prints the password", () => {
    const out = run(["postgres://u:hunter2@localhost/db"]);
    expect(out.errorCode).toBe("bad_usage");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  // The probes run through the project's own driver; a project without `pg`
  // has not been ported yet, and that is the message.
  it("names the missing driver when the project has no pg", () => {
    expect(loadPg(dir)).toBeNull();
    const out = run([], { DATABASE_URL: "postgres://u:p@127.0.0.1:9/db" });
    expect(out).toMatchObject({ ok: false, errorCode: "pg_not_installed" });
    expect(out.error).toMatch(/npm install pg/);
  });
});
