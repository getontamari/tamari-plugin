#!/usr/bin/env node
// Tamari DB migration: before deploy, move an app off local-file SQLite onto the
// injected DATABASE_URL. Config-portable frameworks (Prisma, Django, SQLAlchemy)
// are switched automatically; risky ones (raw SQLite, driver-swap ORMs) are
// reported with an actionable recipe and left untouched.
//
// Every function below is pure over an in-memory ProjectFile[] so the detection
// and rewriting can be unit-tested with no disk and no network. main() is the
// only disk glue, mirroring deploy.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { uncommittedAmong, uncommittedWarning } from "./git.mjs";

/** @typedef {{ path: string, content: string|null, size: number }} ProjectFile */
/** @typedef {{ framework: string, action: "auto"|"warn", files: string[], reason?: string, nextSteps?: string[] }} FrameworkMatch */
/** @typedef {{ matches: FrameworkMatch[], dataFiles: string[] }} Detection */
/** @typedef {{ path: string, newContent: string, summary: string }} Edit */

/** Detector functions are pushed here by each framework's section: (project) => FrameworkMatch|null. */
export const DETECTORS = [];

/** Planner functions keyed by framework id: (project, match) => Edit[]. Populated by the auto sections. */
export const PLANNERS = {};

const DATA_FILE = /\.(db|sqlite|sqlite3)$/i;

/** Tracked, non-empty local database files whose rows the code switch will NOT carry to Postgres. */
export function dataFilesAtRisk(project) {
  return project.filter((p) => DATA_FILE.test(p.path) && p.size > 0).map((p) => p.path);
}

/**
 * Places the app writes to its own disk. Pure — unit-tested.
 *
 * The database detectors find the file that holds every row. They said
 * nothing about the uploads directory beside it, which is wiped on exactly
 * the same schedule — and a real app shipped its photos to disk through
 * multer with every check passing. Tamari injects DATABASE_URL and no blob
 * store, so user media has to go into Postgres (bytea) or an external bucket.
 *
 * Reported, never refused: the same calls write build output, caches and temp
 * files, and only the author knows which writes are user data. Test files,
 * scripts and tooling are skipped, because a write there never runs in the
 * container. One entry per file, naming the first pattern that matched.
 */
const NOT_RUNTIME_CODE =
  /(^|\/)(tests?|__tests__|spec|specs|scripts?|tools?|bin|docs?|\.github|migrations?)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)(test_[^/]*\.py|conftest\.py)$|\.(md|json|ya?ml|toml|lock|txt|sql|html|css)$|\.config\.[cm]?[jt]s$/;

const LOCAL_WRITE_PATTERNS = [
  { pattern: "multer disk storage", re: /multer\.diskStorage\s*\(|multer\s*\(\s*\{[^}]*\bdest\s*:/ },
  { pattern: "fs write", re: /\bfs\.(?:promises\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|mkdir|mkdirSync)\s*\(/ },
  {
    pattern: "fs write",
    re: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|mkdir)\s*\(/,
    requires: /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/,
  },
  { pattern: "express.static over a data directory", re: /express\.static\s*\(\s*[^)]*\b(?:uploads?|media|photos?|images?|files|storage|data)\b/i },
  { pattern: "file save", re: /\.save\s*\(\s*os\.path\.join|\bUPLOAD_FOLDER\b|\bshutil\.(?:copy|copyfile|copy2|move)\s*\(|\bopen\s*\([^)\n]*,\s*["'][wa]b?\+?["']/ },
  { pattern: "os write", re: /\bos\.(?:WriteFile|Create|OpenFile|MkdirAll|Mkdir)\s*\(|\bioutil\.WriteFile\s*\(/ },
];

export function detectLocalWrites(project) {
  const files = [];
  for (const p of project) {
    if (!p.content || NOT_RUNTIME_CODE.test(p.path)) continue;
    for (const { pattern, re, requires } of LOCAL_WRITE_PATTERNS) {
      if (requires && !requires.test(p.content)) continue;
      if (re.test(p.content)) {
        files.push({ path: p.path, pattern });
        break;
      }
    }
  }
  return { files };
}

/** Run every registered detector; collect all persistence layers found, data-at-risk files, and local disk writes. */
export function detectPersistence(project) {
  const matches = [];
  for (const detect of DETECTORS) {
    const m = detect(project);
    if (m) matches.push(m);
  }
  return { matches, dataFiles: dataFilesAtRisk(project), localWrites: detectLocalWrites(project).files };
}

const SET_REQUIRES_DB = 'set "requiresDatabase": true in tamari.json and redeploy.';

/**
 * The injected DATABASE_URL, as a Python driver can use it.
 *
 * The platform writes the URL for node-postgres: `postgres://…?sslmode=no-verify`.
 * SQLAlchemy ≥ 1.4 refuses the `postgres://` scheme outright, and libpq (so
 * psycopg, so Django) rejects `no-verify` as an unknown sslmode — either one
 * crashes the app at startup, on the platform only, after a "successful"
 * deploy. `require` is libpq's name for the same thing (encrypt, no CA check).
 * Normalising in the generated code keeps the rewrite correct for both.
 */
export const PY_DATABASE_URL =
  'os.environ["DATABASE_URL"].replace("postgres://", "postgresql://", 1).replace("sslmode=no-verify", "sslmode=require")';

/** A `from __future__ import` statement must be the first statement in a Python file — prepending
 *  `import os` / `import dj_database_url` above one produces a SyntaxError. A module docstring
 *  above the import is fine and does not match this; only the literal future-import statement does. */
const FUTURE_IMPORT = /^\s*from\s+__future__\s+import\b/m;

/**
 * What a SQLite → Postgres port actually hits, whichever language it is in.
 *
 * Every line here produced a runtime bug or a 500 in a real port before a
 * reviewer caught it. None of them is a find-and-replace, and the advice this
 * replaced — "usually one file, `?` → `$1`, AUTOINCREMENT → SERIAL" — described
 * none of them. Shared by every raw-driver detector; NODE_PG_CHECKLIST adds
 * what is specific to `pg`.
 */
export const SQLITE_TO_POSTGRES_CHECKLIST = [
  "`INTEGER PRIMARY KEY` is SQLite's rowid alias and assigns ids by itself; in Postgres it assigns nothing and the first INSERT fails with a not-null violation. Declare `INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY` (or `SERIAL`).",
  "A forward `REFERENCES` to a table created later in the same script: SQLite tolerates it, Postgres rejects it. Order the CREATE TABLEs by dependency, or add the constraint afterwards with `ALTER TABLE … ADD CONSTRAINT`.",
  "`COLLATE NOCASE`, `SUM(<boolean>)`, one-argument `date(<text>)`, case-insensitive `LIKE` and `x IS NOT ?` do not exist or behave differently: use `LOWER()`/`ILIKE`, `COUNT(*) FILTER (WHERE …)`, `::date`, and `IS DISTINCT FROM`. `INNER` is a reserved word, so `AS inner` is a syntax error.",
  "Postgres `INTEGER` stops at 2,147,483,647; an unbounded integer parser turns an oversized client value into a 500 (22003). Bound the parse, or use BIGINT.",
  "A NUL byte in a text parameter is error 22021; SQLite stored it. Strip or refuse NULs at the edge.",
  "Postgres aborts the whole transaction on any statement error — every later statement fails with 25P02 until ROLLBACK. SQLite did not. Validate before BEGIN, or use SAVEPOINTs.",
  "Any code that lists a directory and selects by extension (migrations/*.sql, templates/*.html) must skip dotfiles: the deployed tree can contain macOS `._name` sidecars that end in the same extension and are not SQL.",
];

/** The `pg`-specific half of the checklist. */
export const NODE_PG_CHECKLIST = [
  "better-sqlite3 is synchronous and `pg` is asynchronous: every query site gains an `await`, every function that queries becomes `async`, and that cascades through every caller, route and test. In a real port that was 112 call sites across 22 files and 16 transactions. Plan for it; do not expect one file.",
  "`pg` returns BIGINT — `COUNT(*)`, `SUM()` over integers — as a string, so `row.n === 0` is `'0' === 0` and false. Register a parser once: `pg.types.setTypeParser(20, Number)` (OID 20 is int8), or cast in SQL.",
  "`SUM()` over a BIGINT column returns NUMERIC (OID 1700), also a string. Cast `SUM(x)::bigint`, or parse that type too.",
  "A transaction needs one client for all of its statements: `const c = await pool.connect(); try { await c.query('BEGIN'); … await c.query('COMMIT'); } finally { c.release(); }`. `pool.query()` calls inside a transaction run on different connections.",
  "Set `connectionTimeoutMillis` on the Pool — it defaults to 0, wait forever — so a database that is not up yet fails fast and the app retries, after it has bound PORT.",
  "`bytea` comes back as a `Buffer` from `pg` and as a `Uint8Array` from PGlite; normalise with `Buffer.from(value)` before `res.send`.",
  "Tests on PGlite never touch the real socket, so bigint-as-string, Buffer vs Uint8Array and pooled transactions first appear in production. Run db-check.mjs against a real Postgres (local, or the provisioned one) before deploying.",
];

function detectNodeRaw(project) {
  const files = [];
  const pkg = project.find((p) => /(^|\/)package\.json$/.test(p.path) && p.content);
  if (pkg) {
    try {
      const j = JSON.parse(pkg.content);
      const deps = { ...j.dependencies, ...j.devDependencies };
      if (deps["better-sqlite3"] || deps["sqlite3"] || deps["@libsql/client"] || deps["libsql"]) files.push(pkg.path);
    } catch {}
  }
  const nodeSqlite = project.find(
    (p) =>
      p.content &&
      /(from\s+["']node:sqlite["']|require\(\s*["']node:sqlite["']\s*\))/.test(p.content),
  );
  if (nodeSqlite) files.push(nodeSqlite.path);
  if (files.length === 0) return null;
  return {
    framework: "node-raw",
    action: "warn",
    files,
    nextSteps: [
      "Replace the SQLite driver (better-sqlite3 / node:sqlite / sqlite3 / libsql) with `pg`, reading process.env.DATABASE_URL. The injected URL ends in `sslmode=no-verify`, which `pg` turns into `ssl: { rejectUnauthorized: false }` by itself.",
      "This is not a find-and-replace. Port the SQL — `?` placeholders become `$1…$n` — and work through every item below; each one broke a real port.",
      ...NODE_PG_CHECKLIST,
      ...SQLITE_TO_POSTGRES_CHECKLIST,
      "Bind PORT before connecting to the database: the platform's startup check is a TCP probe on the port, and a health path that answers 503 while the database is still connecting fails every wake after a sleep. Health answers 200 while connecting; the data routes carry the 503.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectNodeRaw);

function detectGoRaw(project) {
  const mod = project.find((p) => /(^|\/)go\.mod$/.test(p.path) && p.content);
  if (!mod || !/(mattn\/go-sqlite3|modernc\.org\/sqlite|glebarez\/sqlite|ncruces\/go-sqlite3)/.test(mod.content)) return null;
  return {
    framework: "go-raw",
    action: "warn",
    files: [mod.path],
    nextSteps: [
      "Replace the SQLite driver with `github.com/jackc/pgx/v5` (stdlib: `pgx/v5/stdlib`, driver name \"pgx\"), opening os.Getenv(\"DATABASE_URL\"). pgx accepts the injected `sslmode=no-verify` as written.",
      "Port SQLite-specific SQL: `?` placeholders become `$1…$n`, `datetime('now')` becomes now(), and work through every item below; each one broke a real port.",
      ...SQLITE_TO_POSTGRES_CHECKLIST,
      "Bind PORT before connecting to the database: the platform's startup check is a TCP probe on the port, and a health path that answers 503 while the database is still connecting fails every wake after a sleep.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectGoRaw);

function detectPythonRaw(project) {
  const hit = project.find(
    (p) => p.path.endsWith(".py") && p.content && /(\bimport\s+sqlite3\b|\bsqlite3\.connect\s*\()/.test(p.content),
  );
  if (!hit) return null;
  return {
    framework: "python-raw",
    action: "warn",
    files: [hit.path],
    nextSteps: [
      `Replace the \`sqlite3\` module with a Postgres driver such as \`psycopg\`, connecting to ${PY_DATABASE_URL} (the URL is written for node-postgres; psycopg needs the postgresql:// scheme and sslmode=require).`,
      "Port SQLite-specific SQL: `?` placeholders become `%s` in psycopg, and work through every item below; each one broke a real port. psycopg returns NUMERIC as Decimal and BIGINT as int.",
      ...SQLITE_TO_POSTGRES_CHECKLIST,
      "Bind PORT before connecting to the database: the platform's startup check is a TCP probe on the port, and a health path that answers 503 while the database is still connecting fails every wake after a sleep.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectPythonRaw);

function detectDrizzle(project) {
  const cfg = project.find((p) => /(^|\/)drizzle\.config\.(ts|js|mjs|cts|mts)$/.test(p.path) && p.content);
  if (!cfg || !/(dialect\s*:\s*["']sqlite["']|better-sqlite3|@libsql)/.test(cfg.content)) return null;
  return {
    framework: "drizzle",
    action: "warn",
    files: [cfg.path],
    nextSteps: [
      "Switch Drizzle to Postgres: set dialect to 'postgresql', replace the better-sqlite3/libsql driver with `postgres` (or `pg`), and build the client from process.env.DATABASE_URL.",
      "Update drizzle-kit config and regenerate migrations for Postgres.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectDrizzle);

function detectKnex(project) {
  const cfg = project.find((p) => /(^|\/)knexfile\.(ts|js|cjs|mjs)$/.test(p.path) && p.content);
  if (!cfg || !/client\s*:\s*["'](sqlite3|better-sqlite3)["']/.test(cfg.content)) return null;
  return {
    framework: "knex",
    action: "warn",
    files: [cfg.path],
    nextSteps: [
      "Switch the Knex client to 'pg', add the `pg` package, and set the connection to process.env.DATABASE_URL.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectKnex);

function detectSequelize(project) {
  const hit = project.find(
    (p) => p.content && /sequelize/i.test(p.content) && /dialect\s*:\s*["']sqlite["']/.test(p.content),
  );
  if (!hit) return null;
  return {
    framework: "sequelize",
    action: "warn",
    files: [hit.path],
    nextSteps: [
      "Set the Sequelize dialect to 'postgres', add the `pg` package, and build the instance from process.env.DATABASE_URL.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectSequelize);

function detectPrisma(project) {
  const f = project.find((p) => /(^|\/)schema\.prisma$/.test(p.path) && p.content);
  if (!f) return null;
  const sqliteProviders = (f.content.match(/provider\s*=\s*"sqlite"/g) || []).length;
  if (sqliteProviders === 0) return null; // not sqlite → already migrated or another db
  const datasourceBlocks = (f.content.match(/datasource\s+\w+\s*\{/g) || []).length;
  if (sqliteProviders === 1 && datasourceBlocks === 1) {
    return { framework: "prisma", action: "auto", files: [f.path] };
  }
  return {
    framework: "prisma",
    action: "warn",
    files: [f.path],
    reason: "schema.prisma has multiple datasource blocks or an ambiguous provider; migrate it by hand.",
    nextSteps: [
      `In ${f.path}, set the datasource provider to "postgresql" and url = env("DATABASE_URL").`,
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectPrisma);

export function rewritePrisma(content) {
  let out = content.replace(/provider\s*=\s*"sqlite"/g, 'provider = "postgresql"');
  out = out.replace(/url\s*=\s*"file:[^"]*"/g, 'url      = env("DATABASE_URL")');
  if (out === content) return null;
  return {
    newContent: out,
    summary: 'Prisma datasource: provider sqlite → postgresql; url → env("DATABASE_URL")',
  };
}

function planPrismaEdits(project, m) {
  const f = project.find((p) => p.path === m.files[0]);
  const r = rewritePrisma(f.content);
  return r ? [{ path: f.path, newContent: r.newContent, summary: r.summary }] : [];
}
PLANNERS.prisma = planPrismaEdits;

const DJANGO_MANUAL_STEPS = [
  "Add `psycopg[binary]` and `dj-database-url` to your dependency file.",
  `In settings.py set DATABASES["default"] = dj_database_url.config(default=${PY_DATABASE_URL}, conn_max_age=600, ssl_require=True).`,
  `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
];

function detectDjango(project) {
  const f = project.find((p) => /(^|\/)settings\.py$/.test(p.path) && p.content && /DATABASES\s*=/.test(p.content));
  if (!f || !/django\.db\.backends\.sqlite3/.test(f.content)) return null;
  const req = project.find((p) => /(^|\/)requirements\.txt$/.test(p.path) && p.content != null);
  const warn = (reason) => ({ framework: "django", action: "warn", files: [f.path], reason, nextSteps: DJANGO_MANUAL_STEPS });
  if (!req) return warn("no requirements.txt to add the Postgres driver to; migrate by hand.");
  if (!/'default'\s*:\s*\{[^{}]*django\.db\.backends\.sqlite3[^{}]*\}/.test(f.content)) {
    return warn("DATABASES['default'] is not the standard sqlite block; migrate by hand.");
  }
  if (FUTURE_IMPORT.test(f.content)) {
    return warn(`${f.path} has a \`from __future__ import\` statement that must stay first; migrate by hand.`);
  }
  return { framework: "django", action: "auto", files: [f.path, req.path] };
}
DETECTORS.push(detectDjango);

export function rewriteDjangoSettings(content) {
  const out0 = content.replace(
    /'default'\s*:\s*\{[^{}]*django\.db\.backends\.sqlite3[^{}]*\}/,
    `'default': dj_database_url.config(default=${PY_DATABASE_URL}, conn_max_age=600, ssl_require=True)`,
  );
  if (out0 === content) return null;
  const header = [
    /^\s*import\s+os\b/m.test(out0) ? null : "import os",
    /^\s*import\s+dj_database_url\b/m.test(out0) ? null : "import dj_database_url",
  ]
    .filter(Boolean)
    .join("\n");
  const out = header ? `${header}\n${out0}` : out0;
  return { newContent: out, summary: "Django DATABASES → dj_database_url from DATABASE_URL (SSL required)" };
}

/** Append any missing packages to a requirements.txt body; null if all present (idempotent). */
export function addPythonDriver(content, packages) {
  const base = (pkg) => pkg.split("[")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = (pkg) => new RegExp(`^\\s*${base(pkg)}\\b`, "mi").test(content);
  const toAdd = packages.filter((pkg) => !present(pkg));
  if (toAdd.length === 0) return null;
  const sep = content === "" || content.endsWith("\n") ? "" : "\n";
  return {
    newContent: `${content}${sep}${toAdd.join("\n")}\n`,
    summary: `requirements.txt: add ${toAdd.join(", ")}`,
  };
}

function planDjangoEdits(project, m) {
  const settings = project.find((p) => p.path === m.files[0]);
  const req = project.find((p) => p.path === m.files[1]);
  const edits = [];
  const s = rewriteDjangoSettings(settings.content);
  if (s) edits.push({ path: settings.path, newContent: s.newContent, summary: s.summary });
  const d = addPythonDriver(req.content, ["psycopg[binary]", "dj-database-url"]);
  if (d) edits.push({ path: req.path, newContent: d.newContent, summary: d.summary });
  return edits;
}
PLANNERS.django = planDjangoEdits;

const SQLA_LITERAL = /(create_engine\s*\(\s*["']sqlite:\/\/\/[^"']*["']|SQLALCHEMY_DATABASE_URI["']?\s*\]?\s*=\s*["']sqlite:\/\/\/[^"']*["'])/;

const SQLA_MANUAL_NEXT_STEPS = [
  `Point the SQLAlchemy engine/URI at ${PY_DATABASE_URL} and add \`psycopg[binary]\` to your dependencies.`,
  `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
];

/** True if a create_engine("sqlite:///…") call in `content` carries an argument after the URL —
 *  connect_args, echo, poolclass, etc. `connect_args={"check_same_thread": False}` is the common
 *  FastAPI pattern and is SQLite-only; psycopg rejects it at connect time, so rewriting only the
 *  URL would silently break a working app. */
function sqlAlchemyCreateEngineHasExtraArgs(content) {
  const re = /create_engine\s*\(\s*["']sqlite:\/\/\/[^"']*["']\s*(,|\))/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] === ",") return true;
  }
  return false;
}

function detectSqlAlchemy(project) {
  const hit = project.find((p) => p.path.endsWith(".py") && p.content && SQLA_LITERAL.test(p.content));
  if (!hit) return null;
  const warn = (reason) => ({
    framework: "sqlalchemy",
    action: "warn",
    files: [hit.path],
    reason,
    nextSteps: SQLA_MANUAL_NEXT_STEPS,
  });
  if (FUTURE_IMPORT.test(hit.content)) {
    return warn(`${hit.path} has a \`from __future__ import\` statement that must stay first; migrate by hand.`);
  }
  if (sqlAlchemyCreateEngineHasExtraArgs(hit.content)) {
    return warn(
      "SQLAlchemy create_engine has extra arguments (e.g. connect_args) that may be SQLite-specific; migrate by hand.",
    );
  }
  const req = project.find((p) => /(^|\/)requirements\.txt$/.test(p.path) && p.content != null);
  if (!req) {
    return warn("no requirements.txt to add the Postgres driver to; migrate by hand.");
  }
  return { framework: "sqlalchemy", action: "auto", files: [hit.path, req.path] };
}
DETECTORS.push(detectSqlAlchemy);

export function rewriteSqlAlchemy(content) {
  let out = content
    .replace(/create_engine\s*\(\s*["']sqlite:\/\/\/[^"']*["']/g, `create_engine(${PY_DATABASE_URL}`)
    .replace(
      /(SQLALCHEMY_DATABASE_URI["']?\s*\]?\s*=\s*)["']sqlite:\/\/\/[^"']*["']/g,
      `$1${PY_DATABASE_URL}`,
    );
  if (out === content) return null;
  if (!/^\s*import\s+os\b/m.test(out)) out = `import os\n${out}`;
  return { newContent: out, summary: 'SQLAlchemy URL → os.environ["DATABASE_URL"]' };
}

function planSqlAlchemyEdits(project, m) {
  const src = project.find((p) => p.path === m.files[0]);
  const req = project.find((p) => p.path === m.files[1]);
  const edits = [];
  const s = rewriteSqlAlchemy(src.content);
  if (s) edits.push({ path: src.path, newContent: s.newContent, summary: s.summary });
  const d = addPythonDriver(req.content, ["psycopg[binary]"]);
  if (d) edits.push({ path: req.path, newContent: d.newContent, summary: d.summary });
  return edits;
}
PLANNERS.sqlalchemy = planSqlAlchemyEdits;

/** Assemble the single JSON report the agent acts on. `edits` is what was actually applied. */
export function buildReport(detection, edits) {
  const { matches, dataFiles } = detection;
  const localWrites = detection.localWrites ?? [];
  const action =
    matches.length === 0 ? "none" : matches.some((m) => m.action === "auto") ? "auto" : "warn";
  const warnings = [];
  for (const m of matches) if (m.reason) warnings.push(`${m.framework}: ${m.reason}`);
  if (matches.length > 1) {
    warnings.push(
      `More than one persistence layer found (${matches.map((m) => m.framework).join(", ")}); reconcile before deploy.`,
    );
  }
  if (localWrites.length > 0) {
    const named = localWrites.slice(0, 6).map((f) => f.path).join(", ") + (localWrites.length > 6 ? ` and ${localWrites.length - 6} more` : "");
    warnings.push(
      `Writes to the app's own disk in ${named}. The container's disk is wiped every time the app sleeps and Tamari injects ` +
        "DATABASE_URL and no blob store, so user uploads and generated media written there are lost on the first nap. " +
        "Store those bytes in Postgres (bytea) or an external bucket; build output and temp files are fine.",
    );
  }
  return {
    ok: true,
    action,
    changed: edits.map((e) => ({ file: e.path, summary: e.summary })),
    warnings,
    requiresDatabaseSet: edits.some((e) => /(^|\/)tamari\.json$/.test(e.path)),
    dataAtRisk: dataFiles,
    localWrites,
    nextSteps: matches.filter((m) => m.action === "warn").flatMap((m) => m.nextSteps ?? []),
  };
}

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

/** Read the tracked files into ProjectFile[]. Binary files (NUL byte) get content:null. Shared with deploy.mjs. */
export function readProject() {
  // -z: a path may contain a newline, and the newline form quotes it.
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  return paths.map((path) => {
    let size = 0;
    let content = null;
    try {
      size = statSync(path).size;
    } catch {}
    try {
      const text = readFileSync(path, "utf8");
      content = text.includes("\u0000") ? null : text; // a NUL byte ⇒ binary (e.g. a .db file)
    } catch {
      content = null;
    }
    return { path, content, size };
  });
}

/** Write each edit atomically: a temp file then rename, so an interrupted run leaves no half-written config. */
export function applyEdits(edits, write = writeAtomic) {
  for (const e of edits) write(e.path, e.newContent);
}

function writeAtomic(path, content) {
  const tmp = `${path}.tamari-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Turn every `auto` match into bounded edits, plus the requiresDatabase flip when anything was applied. */
export function planAutoEdits(project, matches) {
  const edits = [];
  for (const m of matches) {
    if (m.action !== "auto") continue;
    const planner = PLANNERS[m.framework];
    if (planner) edits.push(...planner(project, m));
  }
  if (edits.length > 0) {
    const sz = project.find((p) => /(^|\/)tamari\.json$/.test(p.path));
    if (sz && sz.content) {
      const r = setRequiresDatabase(sz.content);
      if (r) edits.push({ path: sz.path, newContent: r.newContent, summary: r.summary });
    }
  }
  return edits;
}

/** Flip requiresDatabase to true in tamari.json; null if already true (idempotent). */
export function setRequiresDatabase(content) {
  const manifest = JSON.parse(content);
  if (manifest.requiresDatabase === true) return null;
  manifest.requiresDatabase = true;
  return {
    newContent: `${JSON.stringify(manifest, null, 2)}\n`,
    summary: "tamari.json: requiresDatabase → true",
  };
}

/**
 * readProject() only sees git-tracked files. A `tamari.json` that exists on disk but is not yet
 * tracked (e.g. this is the first run, before the manifest's initial commit) is therefore invisible
 * to `planAutoEdits`, which silently skips the requiresDatabase flip — the app never gets a database
 * on deploy. If the tracked `project` array lacks a `tamari.json` entry, merge one in from the given
 * disk content so the flip can see it. A no-op when the project already has it (tracked content wins)
 * or when there is no disk content to merge. Pure — the disk read itself happens in main() — so the
 * merge is unit-testable with no disk.
 */
export function withManifestFromDisk(project, diskContent) {
  if (diskContent == null) return project;
  if (project.some((p) => p.path === "tamari.json")) return project;
  return [...project, { path: "tamari.json", content: diskContent, size: diskContent.length }];
}

/**
 * Map a thrown error from the disk phase of main() to the `{ errorCode, error }` honest-failure
 * envelope: a readProject() failure means `git ls-files` couldn't run — not a repo, or git
 * missing — reported as `not_a_repo`; an applyEdits() failure means a write failed partway through,
 * reported as `write_failed` naming the offending file when the error carries one.
 */
export function classifyDiskFailure(phase, err) {
  const message = err instanceof Error ? err.message : String(err);
  if (phase === "read") {
    return {
      errorCode: "not_a_repo",
      error: `Could not list tracked files (is this a git repository?): ${message}`,
    };
  }
  const path = err && typeof err === "object" && "path" in err && typeof err.path === "string" ? err.path : "a project file";
  return { errorCode: "write_failed", error: `${path}: ${message}` };
}

async function main() {
  if (!existsSync("tamari.json")) {
    fail("no_manifest", "tamari.json is missing. Create it first, then rerun the migration.");
  }
  let project;
  try {
    project = readProject();
  } catch (err) {
    const { errorCode, error } = classifyDiskFailure("read", err);
    fail(errorCode, error);
    return;
  }
  if (!project.some((p) => p.path === "tamari.json")) {
    try {
      project = withManifestFromDisk(project, readFileSync("tamari.json", "utf8"));
    } catch {
      // existsSync() above already confirmed the file is there; a transient read failure here
      // just means the requiresDatabase flip is skipped for this run, not a hard failure.
    }
  }
  const detection = detectPersistence(project);
  const edits = planAutoEdits(project, detection.matches);

  // Only rewrite what git could put back. SKILL.md promises every change
  // is reversible with git; for a file with uncommitted edits, or an untracked
  // one, that is simply untrue and the rewrite destroys work.
  const targets = [...new Set(edits.map((e) => e.path))];
  const blocked = uncommittedAmong(targets);
  if (blocked === null || blocked.length > 0) {
    const report = buildReport(detection, []);
    const note = blocked === null
      ? {
          warning: "Not rewriting anything: this does not look like a git repository, so no edit here could be undone.",
          nextSteps: ["Run `git init` and commit the project first, then run this again."],
        }
      : uncommittedWarning(blocked);
    console.log(JSON.stringify({
      ...report,
      action: "warn",
      changed: [],
      warnings: [...(report.warnings ?? []), note.warning],
      nextSteps: [...(report.nextSteps ?? []), ...note.nextSteps],
    }, null, 2));
    return;
  }

  try {
    applyEdits(edits);
  } catch (err) {
    const { errorCode, error } = classifyDiskFailure("write", err);
    fail(errorCode, error);
    return;
  }
  console.log(JSON.stringify(buildReport(detection, edits), null, 2));
}

// Run only as the CLI, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
