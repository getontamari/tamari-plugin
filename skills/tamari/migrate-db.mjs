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

/** Run every registered detector; collect all persistence layers found plus data-at-risk files. */
export function detectPersistence(project) {
  const matches = [];
  for (const detect of DETECTORS) {
    const m = detect(project);
    if (m) matches.push(m);
  }
  return { matches, dataFiles: dataFilesAtRisk(project) };
}

const SET_REQUIRES_DB = 'set "requiresDatabase": true in tamari.json and redeploy.';

/** A `from __future__ import` statement must be the first statement in a Python file — prepending
 *  `import os` / `import dj_database_url` above one produces a SyntaxError. A module docstring
 *  above the import is fine and does not match this; only the literal future-import statement does. */
const FUTURE_IMPORT = /^\s*from\s+__future__\s+import\b/m;

function detectNodeRaw(project) {
  const files = [];
  const pkg = project.find((p) => /(^|\/)package\.json$/.test(p.path) && p.content);
  if (pkg) {
    try {
      const j = JSON.parse(pkg.content);
      const deps = { ...j.dependencies, ...j.devDependencies };
      if (deps["better-sqlite3"] || deps["sqlite3"]) files.push(pkg.path);
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
      "Replace the SQLite driver (better-sqlite3 / node:sqlite / sqlite3) with a Postgres client such as `pg`, reading process.env.DATABASE_URL.",
      "Port SQLite-specific SQL: `?` placeholders become `$1…$n`, AUTOINCREMENT becomes a SERIAL/IDENTITY column.",
      `Once the app talks to Postgres, ${SET_REQUIRES_DB}`,
    ],
  };
}
DETECTORS.push(detectNodeRaw);

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
      "Replace the `sqlite3` module with a Postgres driver such as `psycopg`, reading os.environ['DATABASE_URL'].",
      "Port SQLite-specific SQL: `?` placeholders become `%s` in psycopg.",
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
  'In settings.py set DATABASES["default"] = dj_database_url.config(default=os.environ["DATABASE_URL"], conn_max_age=600, ssl_require=True).',
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
    "'default': dj_database_url.config(default=os.environ[\"DATABASE_URL\"], conn_max_age=600, ssl_require=True)",
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
  "Point the SQLAlchemy engine/URI at os.environ['DATABASE_URL'] and add `psycopg[binary]` to your dependencies.",
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
    .replace(/create_engine\s*\(\s*["']sqlite:\/\/\/[^"']*["']/g, 'create_engine(os.environ["DATABASE_URL"]')
    .replace(
      /(SQLALCHEMY_DATABASE_URI["']?\s*\]?\s*=\s*)["']sqlite:\/\/\/[^"']*["']/g,
      '$1os.environ["DATABASE_URL"]',
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
  const action =
    matches.length === 0 ? "none" : matches.some((m) => m.action === "auto") ? "auto" : "warn";
  const warnings = [];
  for (const m of matches) if (m.reason) warnings.push(`${m.framework}: ${m.reason}`);
  if (matches.length > 1) {
    warnings.push(
      `More than one persistence layer found (${matches.map((m) => m.framework).join(", ")}); reconcile before deploy.`,
    );
  }
  return {
    ok: true,
    action,
    changed: edits.map((e) => ({ file: e.path, summary: e.summary })),
    warnings,
    requiresDatabaseSet: edits.some((e) => /(^|\/)tamari\.json$/.test(e.path)),
    dataAtRisk: dataFiles,
    nextSteps: matches.filter((m) => m.action === "warn").flatMap((m) => m.nextSteps ?? []),
  };
}

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

/** Read the tracked files into ProjectFile[]. Binary files (NUL byte) get content:null. */
function readProject() {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
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
