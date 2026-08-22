// @vitest-environment node
//
// The migrator is the skill step that rewrites a user's source before deploy.
// Every function here is pure over an in-memory ProjectFile[] — no disk, no
// network — so the detection and rewriting are pinned exactly.

import { describe, expect, it } from "vitest";

import {
  dataFilesAtRisk,
  detectPersistence,
  buildReport,
  rewritePrisma,
  planAutoEdits,
  applyEdits,
  rewriteDjangoSettings,
  addPythonDriver,
  rewriteSqlAlchemy,
  withManifestFromDisk,
  classifyDiskFailure,
} from "../skills/tamari/migrate-db.mjs";

/** @typedef {import("../skills/tamari/migrate-db.mjs")} */

const file = (path: string, content: string | null, size = content ? content.length : 0) => ({
  path,
  content,
  size,
});

describe("dataFilesAtRisk", () => {
  it("reports a non-empty sqlite file and ignores an empty one", () => {
    const project = [
      file("data/app.db", null, 8192),
      file("empty.sqlite", null, 0),
      file("src/index.js", "console.log(1)"),
    ];
    expect(dataFilesAtRisk(project)).toEqual(["data/app.db"]);
  });
});

describe("detectPersistence + buildReport: none", () => {
  it("reports action none when there is no persistence signal", () => {
    const project = [file("index.html", "<h1>hi</h1>")];
    const detection = detectPersistence(project);
    expect(detection.matches).toEqual([]);
    const report = buildReport(detection, []);
    expect(report).toEqual({
      ok: true,
      action: "none",
      changed: [],
      warnings: [],
      requiresDatabaseSet: false,
      dataAtRisk: [],
      nextSteps: [],
    });
  });

  it("surfaces a data-at-risk file even when action is none", () => {
    const detection = detectPersistence([file("app.sqlite3", null, 4096)]);
    const report = buildReport(detection, []);
    expect(report.action).toBe("none");
    expect(report.dataAtRisk).toEqual(["app.sqlite3"]);
  });
});

describe("warn detectors", () => {
  it("warns on better-sqlite3 in package.json without editing", () => {
    const project = [
      file("package.json", JSON.stringify({ dependencies: { "better-sqlite3": "^11.0.0" } })),
    ];
    const detection = detectPersistence(project);
    expect(detection.matches).toHaveLength(1);
    expect(detection.matches[0]).toMatchObject({ framework: "node-raw", action: "warn" });
    const report = buildReport(detection, []);
    expect(report.action).toBe("warn");
    expect(report.changed).toEqual([]);
    expect(report.requiresDatabaseSet).toBe(false);
    expect(report.nextSteps.length).toBeGreaterThan(0);
  });

  it("warns on node:sqlite imports", () => {
    const project = [file("db.js", 'import { DatabaseSync } from "node:sqlite";')];
    expect(detectPersistence(project).matches[0].framework).toBe("node-raw");
  });

  it("warns on python import sqlite3", () => {
    const project = [file("app.py", "import sqlite3\nconn = sqlite3.connect('x.db')")];
    expect(detectPersistence(project).matches[0].framework).toBe("python-raw");
  });

  it("warns on a Drizzle sqlite config", () => {
    const project = [file("drizzle.config.ts", 'export default { dialect: "sqlite" }')];
    expect(detectPersistence(project).matches[0]).toMatchObject({ framework: "drizzle", action: "warn" });
  });

  it("warns on a Knex sqlite3 client", () => {
    const project = [file("knexfile.js", "module.exports = { client: 'sqlite3' }")];
    expect(detectPersistence(project).matches[0].framework).toBe("knex");
  });

  it("warns on a Sequelize sqlite dialect", () => {
    const project = [file("db.js", 'const s = new Sequelize({ dialect: "sqlite" });')];
    expect(detectPersistence(project).matches[0].framework).toBe("sequelize");
  });

  it("reports the reconcile warning when two persistence layers coexist", () => {
    const project = [
      file("package.json", JSON.stringify({ dependencies: { "better-sqlite3": "^11.0.0" } })),
      file("app.py", "import sqlite3"),
    ];
    const report = buildReport(detectPersistence(project), []);
    expect(report.warnings.some((w) => /more than one persistence layer/i.test(w))).toBe(true);
  });
});

const PRISMA_SQLITE = `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

generator client {
  provider = "prisma-client-js"
}
`;

const TAMARI = JSON.stringify({ app: "notes", runtime: "node", requiresDatabase: false }, null, 2);

describe("Prisma auto-fix", () => {
  it("rewrites provider and url", () => {
    const out = rewritePrisma(PRISMA_SQLITE)!;
    expect(out.newContent).toContain('provider = "postgresql"');
    expect(out.newContent).toContain('url      = env("DATABASE_URL")');
    expect(out.newContent).not.toContain('"sqlite"');
    expect(out.newContent).not.toContain("file:");
  });

  it("classifies a clean sqlite schema as auto and plans the edits", () => {
    const project = [
      file("prisma/schema.prisma", PRISMA_SQLITE),
      file("tamari.json", TAMARI),
    ];
    const detection = detectPersistence(project);
    expect(detection.matches[0]).toMatchObject({ framework: "prisma", action: "auto" });

    const edits = planAutoEdits(project, detection.matches);
    const paths = edits.map((e) => e.path).sort();
    expect(paths).toEqual(["prisma/schema.prisma", "tamari.json"]);

    const report = buildReport(detection, edits);
    expect(report.action).toBe("auto");
    expect(report.requiresDatabaseSet).toBe(true);
    expect(report.changed.map((c) => c.file)).toContain("prisma/schema.prisma");
  });

  it("is idempotent: an already-postgres schema is no match", () => {
    const migrated = PRISMA_SQLITE.replace('"sqlite"', '"postgresql"').replace(
      '"file:./dev.db"',
      'env("DATABASE_URL")',
    );
    const project = [file("prisma/schema.prisma", migrated), file("tamari.json", TAMARI)];
    const detection = detectPersistence(project);
    expect(detection.matches).toEqual([]);
    expect(buildReport(detection, planAutoEdits(project, detection.matches)).action).toBe("none");
  });

  it("downgrades a schema with two datasource blocks to warn", () => {
    const twoBlocks = PRISMA_SQLITE + `\ndatasource other {\n  provider = "sqlite"\n  url = "file:./b.db"\n}\n`;
    const detection = detectPersistence([file("schema.prisma", twoBlocks), file("tamari.json", TAMARI)]);
    expect(detection.matches[0]).toMatchObject({ framework: "prisma", action: "warn" });
    expect(detection.matches[0].reason).toBeTruthy();
  });

  it("applyEdits writes each edit through the injected writer", () => {
    const written = new Map<string, string>();
    applyEdits(
      [{ path: "a.txt", newContent: "X", summary: "s" }],
      (p, c) => written.set(p, c),
    );
    expect(written.get("a.txt")).toBe("X");
  });
});

const DJANGO_SETTINGS = `import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}
`;

describe("addPythonDriver", () => {
  it("adds only missing packages and is idempotent", () => {
    const first = addPythonDriver("django==5.0\n", ["psycopg[binary]", "dj-database-url"])!;
    expect(first.newContent).toContain("psycopg[binary]");
    expect(first.newContent).toContain("dj-database-url");
    expect(addPythonDriver(first.newContent, ["psycopg[binary]", "dj-database-url"])).toBeNull();
  });

  it("appends a newline before adding when the file lacks a trailing one", () => {
    const out = addPythonDriver("flask", ["psycopg[binary]"])!;
    expect(out.newContent).toBe("flask\npsycopg[binary]\n");
  });
});

describe("Django auto-fix", () => {
  it("rewrites DATABASES to dj_database_url and requires SSL", () => {
    const out = rewriteDjangoSettings(DJANGO_SETTINGS)!;
    expect(out.newContent).toContain("dj_database_url.config(");
    expect(out.newContent).toContain('os.environ["DATABASE_URL"]');
    expect(out.newContent).toContain("ssl_require=True");
    expect(out.newContent).not.toContain("django.db.backends.sqlite3");
    expect(out.newContent).toContain("import dj_database_url");
  });

  it("classifies django+requirements as auto and edits settings + requirements", () => {
    const project = [
      file("myproj/settings.py", DJANGO_SETTINGS),
      file("requirements.txt", "django==5.0\n"),
      file("tamari.json", TAMARI),
    ];
    const detection = detectPersistence(project);
    expect(detection.matches[0]).toMatchObject({ framework: "django", action: "auto" });
    const edits = planAutoEdits(project, detection.matches);
    const paths = edits.map((e) => e.path).sort();
    expect(paths).toEqual(["myproj/settings.py", "requirements.txt", "tamari.json"]);
  });

  it("downgrades to warn when there is no requirements.txt", () => {
    const project = [file("settings.py", DJANGO_SETTINGS), file("tamari.json", TAMARI)];
    expect(detectPersistence(project).matches[0]).toMatchObject({ framework: "django", action: "warn" });
  });
});

describe("SQLAlchemy auto-fix", () => {
  it("rewrites create_engine and adds import os", () => {
    const out = rewriteSqlAlchemy('engine = create_engine("sqlite:///./app.db")\n')!;
    expect(out.newContent).toContain('create_engine(os.environ["DATABASE_URL"]');
    expect(out.newContent).toContain("import os");
    expect(out.newContent).not.toContain("sqlite:///");
  });

  it("rewrites a Flask SQLALCHEMY_DATABASE_URI literal", () => {
    const out = rewriteSqlAlchemy("app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///x.db'\n")!;
    expect(out.newContent).toContain('os.environ["DATABASE_URL"]');
  });

  it("classifies a literal create_engine + requirements as auto", () => {
    const project = [
      file("app.py", 'from sqlalchemy import create_engine\nengine = create_engine("sqlite:///./app.db")\n'),
      file("requirements.txt", "sqlalchemy\n"),
      file("tamari.json", TAMARI),
    ];
    const detection = detectPersistence(project);
    expect(detection.matches[0]).toMatchObject({ framework: "sqlalchemy", action: "auto" });
    const edits = planAutoEdits(project, detection.matches);
    expect(edits.find((e) => e.path === "requirements.txt")!.newContent).toContain("psycopg[binary]");
  });

  it("downgrades a non-literal engine URL to warn", () => {
    const project = [
      file("app.py", "engine = create_engine(DB_URL)\nimport sqlite3 as _sqlite_marker  # sqlite:///x"),
      file("requirements.txt", "sqlalchemy\n"),
      file("tamari.json", TAMARI),
    ];
    const sa = detectPersistence(project).matches.find((m) => m.framework === "sqlalchemy");
    // No sqlite:/// literal for SQLAlchemy → it should not be an auto sqlalchemy match.
    expect(sa).toBeUndefined();
  });
});

describe("integration: mixed auto + warn project", () => {
  it("applies Prisma, flips requiresDatabase, warns on a leftover, and flags data", () => {
    const project = [
      file("prisma/schema.prisma", PRISMA_SQLITE),
      file("package.json", JSON.stringify({ dependencies: { "better-sqlite3": "^11.0.0" } })),
      file("legacy.db", null, 12288),
      file("tamari.json", TAMARI),
    ];
    const detection = detectPersistence(project);
    const edits = planAutoEdits(project, detection.matches);
    const report = buildReport(detection, edits);

    expect(report.action).toBe("auto"); // an auto match is present
    expect(report.requiresDatabaseSet).toBe(true);
    expect(report.changed.map((c) => c.file).sort()).toEqual(["prisma/schema.prisma", "tamari.json"]);
    expect(report.nextSteps.length).toBeGreaterThan(0); // from the node-raw warn
    expect(report.warnings.some((w) => /more than one persistence layer/i.test(w))).toBe(true);
    expect(report.dataAtRisk).toEqual(["legacy.db"]);
  });
});

// FIX 1 (from review): readProject() only sees git-tracked files, but main() gates on
// existsSync("tamari.json") (disk). A freshly-created, untracked tamari.json is therefore missing
// from `project`, so planAutoEdits silently skips the requiresDatabase flip even though an auto
// edit was applied — provisioning then provides no database and the app crashes on an unset DATABASE_URL.
// withManifestFromDisk is the seam main() uses to merge the on-disk manifest in before planning.
describe("withManifestFromDisk (FIX 1)", () => {
  it("reproduces the bug: the flip is skipped when tamari.json is untracked, and fires once merged in", () => {
    // tamari.json exists on disk (main()'s existsSync check would pass) but is NOT in the tracked
    // project array — exactly the untracked-manifest case that defeated the flip.
    const trackedProject = [file("prisma/schema.prisma", PRISMA_SQLITE)];
    const detection = detectPersistence(trackedProject);
    expect(detection.matches[0]).toMatchObject({ framework: "prisma", action: "auto" });

    const editsWithoutManifest = planAutoEdits(trackedProject, detection.matches);
    expect(editsWithoutManifest.map((e) => e.path)).toEqual(["prisma/schema.prisma"]);
    expect(editsWithoutManifest.some((e) => e.path === "tamari.json")).toBe(false); // the bug: no flip

    const merged = withManifestFromDisk(trackedProject, TAMARI);
    const editsWithManifest = planAutoEdits(merged, detection.matches);
    expect(editsWithManifest.map((e) => e.path).sort()).toEqual(["prisma/schema.prisma", "tamari.json"]);
    const flip = editsWithManifest.find((e) => e.path === "tamari.json")!;
    expect(JSON.parse(flip.newContent).requiresDatabase).toBe(true);
  });

  it("is a no-op when tamari.json is already tracked — the tracked content wins", () => {
    const project = [file("tamari.json", TAMARI)];
    const merged = withManifestFromDisk(project, JSON.stringify({ requiresDatabase: true }));
    expect(merged).toBe(project);
  });

  it("is a no-op when there is no disk content to merge (main() couldn't read the file)", () => {
    const project = [file("package.json", "{}")];
    expect(withManifestFromDisk(project, null)).toBe(project);
  });
});

// FIX 3 (from review): main()'s disk phase (readProject / applyEdits) had no error handling,
// so a non-git project or a mid-run write failure would print a raw stack trace instead of the
// { ok: false, errorCode, error } contract and SKILL.md promise. classifyDiskFailure is the
// pure mapping main() uses inside its try/catch around each phase.
describe("classifyDiskFailure (FIX 3)", () => {
  it("classifies a readProject() failure (git ls-files threw) as not_a_repo", () => {
    const err = new Error("fatal: not a git repository (or any of the parent directories): .git");
    expect(classifyDiskFailure("read", err)).toEqual({
      errorCode: "not_a_repo",
      error: `Could not list tracked files (is this a git repository?): ${err.message}`,
    });
  });

  it("classifies an applyEdits() failure as write_failed, naming the offending file", () => {
    const err = Object.assign(new Error("EACCES: permission denied"), { path: "schema.prisma" });
    expect(classifyDiskFailure("write", err)).toEqual({
      errorCode: "write_failed",
      error: "schema.prisma: EACCES: permission denied",
    });
  });

  it("falls back to a generic file label when the write error carries no path", () => {
    expect(classifyDiskFailure("write", new Error("disk full"))).toEqual({
      errorCode: "write_failed",
      error: "a project file: disk full",
    });
  });

  it("stringifies a non-Error throw instead of crashing", () => {
    expect(classifyDiskFailure("read", "boom")).toEqual({
      errorCode: "not_a_repo",
      error: "Could not list tracked files (is this a git repository?): boom",
    });
  });
});
// Not implemented: an end-to-end test that runs `node migrate-db.mjs` via execFileSync in a real
// temp directory that is (a) not a git repo and (b) has a read-only project file, asserting the
// process prints valid `{ ok: false, errorCode, error }` JSON and exits 1 with no stack trace on
// stdout. Skipped because it needs real subprocess + filesystem fixtures (temp dirs, chmod, cleanup)
// which is heavier than this file's pure in-memory style; classifyDiskFailure above pins the exact
// mapping main() applies, and the wiring itself is a few lines reviewable by inspection.

// FIX 2 (from review): rewriteSqlAlchemy only swaps the URL, so
// create_engine("sqlite:///./app.db", connect_args={"check_same_thread": False}) would keep the
// SQLite-only connect_args after rewrite — psycopg rejects that DBAPI option at connect time,
// breaking a working FastAPI app. detectSqlAlchemy must downgrade that case to warn instead.
describe("SQLAlchemy create_engine with extra args (FIX 2)", () => {
  it("downgrades to warn instead of carrying SQLite-only connect_args into the Postgres engine", () => {
    const project = [
      file(
        "app.py",
        'engine = create_engine("sqlite:///./app.db", connect_args={"check_same_thread": False})\n',
      ),
      file("requirements.txt", "sqlalchemy\n"),
      file("tamari.json", TAMARI),
    ];
    const detection = detectPersistence(project);
    const match = detection.matches.find((m) => m.framework === "sqlalchemy")!;
    expect(match).toMatchObject({ framework: "sqlalchemy", action: "warn" });
    expect(match.reason).toMatch(/extra arguments/i);
    const edits = planAutoEdits(project, detection.matches);
    expect(edits).toEqual([]);
  });

  it("still auto-fixes a bare create_engine with no extra arguments", () => {
    const project = [
      file("app.py", 'engine = create_engine("sqlite:///./app.db")\n'),
      file("requirements.txt", "sqlalchemy\n"),
      file("tamari.json", TAMARI),
    ];
    const detection = detectPersistence(project);
    expect(detection.matches.find((m) => m.framework === "sqlalchemy")).toMatchObject({
      framework: "sqlalchemy",
      action: "auto",
    });
  });
});

// FIX 6 (from review): rewriteDjangoSettings / rewriteSqlAlchemy prepend `import os` (etc.) at
// the very top of the file. If the file has a `from __future__ import …` statement, that must stay
// the first statement in the file — prepending an import above it is a SyntaxError. A module
// docstring above the import is fine and must NOT trigger this downgrade; only the literal
// `from __future__ import` text does.
describe("from __future__ import guard (FIX 6)", () => {
  it("downgrades Django settings.py to warn when it starts with a from __future__ import", () => {
    const withFuture = `from __future__ import annotations\n\n${DJANGO_SETTINGS}`;
    const project = [
      file("settings.py", withFuture),
      file("requirements.txt", "django==5.0\n"),
      file("tamari.json", TAMARI),
    ];
    const match = detectPersistence(project).matches.find((m) => m.framework === "django")!;
    expect(match).toMatchObject({ framework: "django", action: "warn" });
    expect(match.reason).toMatch(/from __future__ import/);
  });

  it("downgrades a SQLAlchemy app.py to warn when it starts with a from __future__ import", () => {
    const withFuture =
      'from __future__ import annotations\nfrom sqlalchemy import create_engine\nengine = create_engine("sqlite:///./app.db")\n';
    const project = [
      file("app.py", withFuture),
      file("requirements.txt", "sqlalchemy\n"),
      file("tamari.json", TAMARI),
    ];
    const match = detectPersistence(project).matches.find((m) => m.framework === "sqlalchemy")!;
    expect(match).toMatchObject({ framework: "sqlalchemy", action: "warn" });
    expect(match.reason).toMatch(/from __future__ import/);
  });

  it("does not downgrade for a module docstring — only the literal future-import statement", () => {
    const withDocstring =
      '"""App entrypoint."""\nfrom sqlalchemy import create_engine\nengine = create_engine("sqlite:///./app.db")\n';
    const project = [
      file("app.py", withDocstring),
      file("requirements.txt", "sqlalchemy\n"),
      file("tamari.json", TAMARI),
    ];
    const match = detectPersistence(project).matches.find((m) => m.framework === "sqlalchemy")!;
    expect(match).toMatchObject({ framework: "sqlalchemy", action: "auto" });
  });
});
