#!/usr/bin/env node
// Tamari db-check: one real connection to a Postgres, with the probes that
// separate "the URL connects" from "the app will work against it".
//
// Tests that obey the no-network rule run on PGlite, and PGlite is not the
// wire: BIGINT arriving as a string, bytea as Buffer rather than Uint8Array,
// a NUL byte refused with 22021, the whole transaction aborting on one bad
// statement, INTEGER PRIMARY KEY assigning nothing. All of that was first met
// in production by a real port. This runs those probes from the developer's
// machine against a local Postgres, or against the provisioned one where it is
// reachable, and prints codes an agent can act on.
//
// The client is the project's own `pg` (this plugin has no dependencies and
// ships as source), so the probes exercise exactly the driver the app will
// run. The URL is taken by reference, an environment variable or a file, never
// from an argument: an argument is readable by every process on the machine
// and lands in shell history and the agent transcript. The output never
// repeats the password.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function fail(code, message, extra = {}) { out({ ok: false, errorCode: code, error: message, ...extra }); process.exit(1); }

const NUL = String.fromCharCode(0);

/**
 * Parse argv (after the script name). Pure; unit-tested.
 *
 *   (no flags)           read DATABASE_URL from the environment
 *   --from-env <VAR>     read the URL from another variable
 *   --from-file <path>   read the URL from a file (one line)
 *
 * A URL given as an argument is refused, for the same reason secrets.mjs
 * refuses `set KEY=value`: the password would be in `ps`, shell history and
 * this transcript.
 */
export function parseDbCheckArgs(argv) {
  const args = [...argv];
  let from = { kind: "env", name: "DATABASE_URL" };
  while (args.length > 0) {
    let flag = args.shift();
    let value;
    const eq = flag.indexOf("=");
    if (flag.startsWith("--") && eq !== -1) { value = flag.slice(eq + 1); flag = flag.slice(0, eq); }
    if (/^postgres(ql)?:\/\//i.test(flag)) {
      return { error: "Refusing a database URL as an argument: the password would be visible in `ps`, written to shell history and captured in this transcript. Put it in DATABASE_URL, or pass --from-file <path> / --from-env <VAR>." };
    }
    if (flag === "--from-env" || flag === "--from-file") {
      if (value === undefined) value = args.shift();
      if (!value) return { error: `${flag} needs a value.` };
      from = flag === "--from-env" ? { kind: "env", name: value } : { kind: "file", path: value };
      continue;
    }
    return { error: `Unknown option ${flag}. Usage: db-check [--from-env <VAR> | --from-file <path>] (default: $DATABASE_URL)` };
  }
  return { from };
}

/** The URL with its password replaced, for output. Pure; unit-tested. */
export function redactDatabaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable database URL>";
  }
}

/**
 * Why a connection did not open, as a stage. Pure; unit-tested.
 *
 * `tcp`: nothing answered (the provisioned database is on a private network
 * and is not reachable from a laptop without a tunnel; a local one is not
 * running). `tls`: the socket opened and the handshake failed. `auth`: the
 * server refused the credentials. `database`: the named database does not
 * exist.
 */
export function classifyConnectError(err) {
  const code = err?.code ?? "";
  const message = err?.message ?? String(err);
  if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET)$/.test(code) || /timeout/i.test(message)) {
    return { stage: "tcp", code: code || "timeout", hint: "Nothing answered on that host and port. The provisioned database is on a private network: reach it through a tunnel, or point this at a local Postgres to exercise the driver." };
  }
  if (/CERT|TLS|SSL|handshake|self.signed/i.test(`${code} ${message}`)) {
    return { stage: "tls", code, hint: "The socket opened but TLS failed. The injected URL carries sslmode=no-verify, which node-postgres maps to ssl: { rejectUnauthorized: false }; psycopg and libpq need sslmode=require instead." };
  }
  if (/^28/.test(code)) return { stage: "auth", code, hint: "The server refused the credentials." };
  if (code === "3D000") return { stage: "database", code, hint: "The named database does not exist on that server." };
  return { stage: "unknown", code, hint: message };
}

/** The project's own `pg`, or null when it is not installed here. */
export function loadPg(cwd = process.cwd()) {
  try {
    return createRequire(join(cwd, "package.json"))("pg");
  } catch {
    return null;
  }
}

const probe = async (name, run) => {
  try {
    return { name, ...(await run()) };
  } catch (err) {
    return { name, status: "fail", code: err?.code ?? null, detail: err?.message ?? String(err) };
  }
};
const unless = (err, code) => (err?.code === code ? null : err);

/**
 * The probes, against anything with `query(text, params) -> { rows }` that
 * throws errors carrying a Postgres `code`. Pure over that client; unit-tested
 * with a stub. Each result is `ok`, `warn` (it works, and the app has to know
 * about it) or `fail`.
 */
export async function runProbes(client) {
  const results = [];
  const q = (text, params) => client.query(text, params);

  results.push(await probe("server_version", async () => {
    const { rows } = await q("SELECT current_setting('server_version') AS v");
    return { status: "ok", detail: `PostgreSQL ${rows[0].v}` };
  }));

  results.push(await probe("extended_query_non_ascii", async () => {
    const s = "héllo ✓ 日本";
    const { rows } = await q("SELECT $1::text AS t, $2::int AS n", [s, 7]);
    return rows[0].t === s && rows[0].n === 7
      ? { status: "ok", detail: "parameters round-trip, non-ASCII intact" }
      : { status: "fail", detail: `got ${JSON.stringify(rows[0])}` };
  }));

  results.push(await probe("bigint_type", async () => {
    const { rows } = await q("SELECT COUNT(*) AS n FROM (VALUES (1), (2)) AS v(x)");
    const t = typeof rows[0].n;
    return t === "number"
      ? { status: "ok", detail: "COUNT(*) arrives as a number (a parser for OID 20 is registered)" }
      : { status: "warn", detail: `COUNT(*) arrives as a ${t} ('${rows[0].n}'), so \`row.n === 0\` is false for an empty table. Register pg.types.setTypeParser(20, Number) or cast in SQL.` };
  }));

  results.push(await probe("numeric_type", async () => {
    const { rows } = await q("SELECT SUM(x) AS s FROM (VALUES (1::bigint), (2::bigint)) AS v(x)");
    const t = typeof rows[0].s;
    return t === "number"
      ? { status: "ok", detail: "SUM over BIGINT arrives as a number" }
      : { status: "warn", detail: `SUM over BIGINT is NUMERIC and arrives as a ${t} ('${rows[0].s}'). Cast SUM(x)::bigint, or register a parser for OID 1700.` };
  }));

  results.push(await probe("bytea_type", async () => {
    const { rows } = await q("SELECT decode('00ff', 'hex') AS b");
    const b = rows[0].b;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(b)) return { status: "ok", detail: "bytea arrives as a Buffer" };
    if (b instanceof Uint8Array) return { status: "warn", detail: "bytea arrives as a Uint8Array, not a Buffer (PGlite does this). Normalise with Buffer.from(value) before res.send." };
    return { status: "fail", detail: `bytea arrived as ${typeof b}` };
  }));

  results.push(await probe("nul_in_parameter", async () => {
    try {
      await q("SELECT $1::text AS t", [`a${NUL}b`]);
      return { status: "warn", detail: "a NUL byte in a text parameter was accepted; a real Postgres refuses it with 22021, so validate at the edge anyway" };
    } catch (err) {
      const other = unless(err, "22021");
      if (other) throw other;
      return { status: "ok", detail: "a NUL byte in a text parameter is refused with 22021 (SQLite stored it): strip or refuse NULs at the edge" };
    }
  }));

  results.push(await probe("transaction_abort", async () => {
    await q("BEGIN");
    try {
      try { await q("SELECT 1/0"); } catch (err) { const other = unless(err, "22012"); if (other) throw other; }
      try {
        await q("SELECT 1");
        return { status: "warn", detail: "a statement after a failed one succeeded inside the transaction; a real Postgres aborts the whole transaction (25P02)" };
      } catch (err) {
        const other = unless(err, "25P02");
        if (other) throw other;
        return { status: "ok", detail: "one failed statement aborts the whole transaction (25P02 on everything after it, until ROLLBACK): validate before BEGIN, or use SAVEPOINTs" };
      }
    } finally {
      await q("ROLLBACK").catch(() => {});
    }
  }));

  results.push(await probe("integer_primary_key_assigns_nothing", async () => {
    await q("CREATE TEMP TABLE tamari_db_check_ipk (id INTEGER PRIMARY KEY, v TEXT)");
    try {
      await q("INSERT INTO tamari_db_check_ipk (v) VALUES ('x')");
      return { status: "warn", detail: "INSERT without an id succeeded; this is not Postgres behaviour, where INTEGER PRIMARY KEY assigns nothing" };
    } catch (err) {
      const other = unless(err, "23502");
      if (other) throw other;
      return { status: "ok", detail: "INTEGER PRIMARY KEY assigns nothing (23502 on INSERT without an id): declare it GENERATED BY DEFAULT AS IDENTITY" };
    } finally {
      await q("DROP TABLE IF EXISTS tamari_db_check_ipk").catch(() => {});
    }
  }));

  results.push(await probe("large_result", async () => {
    const { rows } = await q("SELECT length(repeat('x', 200000)) AS n");
    return Number(rows[0].n) === 200000 ? { status: "ok", detail: "a 200 KB result arrives intact" } : { status: "fail", detail: `length ${rows[0].n}` };
  }));

  return results;
}

async function main() {
  const parsed = parseDbCheckArgs(process.argv.slice(2));
  if ("error" in parsed) fail("bad_usage", parsed.error);

  let url = null;
  if (parsed.from.kind === "env") {
    url = process.env[parsed.from.name] ?? null;
    if (!url) fail("database_url_unreadable", `$${parsed.from.name} is not set. Export it, or pass --from-file <path>.`);
  } else {
    try { url = readFileSync(parsed.from.path, "utf8").replace(/\r?\n$/, "").trim(); } catch { fail("database_url_unreadable", `Cannot read ${parsed.from.path}.`); }
    if (!url) fail("database_url_unreadable", `${parsed.from.path} is empty.`);
  }

  const pg = loadPg();
  if (!pg) {
    fail("pg_not_installed",
      "The `pg` package is not installed in this project, and these probes run through the app's own driver. Run `npm install pg` here first (the port needs it anyway).");
  }

  const database = redactDatabaseUrl(url);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 20_000 });
  const startedAt = Date.now();
  try {
    await client.connect();
  } catch (err) {
    const why = classifyConnectError(err);
    return fail("database_unreachable", `Could not connect to ${database}: ${why.stage} failed (${why.code || "no code"}). ${why.hint}`, {
      database,
      stage: why.stage,
      code: why.code,
    });
  }
  const connectMs = Date.now() - startedAt;

  let probes;
  try {
    probes = await runProbes(client);
  } finally {
    await client.end().catch(() => {});
  }
  const failed = probes.filter((p) => p.status === "fail");
  const warned = probes.filter((p) => p.status === "warn");
  const notes = [];
  if (warned.length > 0) notes.push(`${warned.length} probe${warned.length === 1 ? "" : "s"} report behaviour the app has to handle. Read each \`detail\`; every one of them has produced a runtime bug in a real port.`);
  if (/sslmode=no-verify/.test(url)) notes.push("The URL carries sslmode=no-verify, as the platform injects it: node-postgres maps it to ssl: { rejectUnauthorized: false }; psycopg and libpq need sslmode=require instead; pgx accepts it as written.");
  out({ ok: failed.length === 0, database, connected: true, connectMs, probes, notes });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((error) => {
    fail("db_check_failed", error?.message ?? String(error));
  });
}
