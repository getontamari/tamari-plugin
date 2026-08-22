// deploy.mjs refuses to ship an app whose data lives in a local database file.
//
// The first real app deployed with this plugin kept its data in SQLite inside
// the container; deploy reported ✓, the user entered data, the app slept, and
// the next instance booted with the empty file from the image. The check
// existed in migrate-db.mjs but was a separate, skippable step — so now the
// deploy itself runs it, before anything leaves the machine.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localDatabaseGuard } from "../skills/tamari/deploy.mjs";
import { detectPersistence } from "../skills/tamari/migrate-db.mjs";

const file = (path: string, content: string) => ({ path, content, size: content.length });
const node = { app: "x", name: "X", runtime: "node", resourceClass: "personal", healthPath: "/healthz", requiresDatabase: false };

const rawSqlite = {
  matches: [{ framework: "python-raw", action: "warn" as const, files: ["app/db.py"], nextSteps: ["Replace sqlite3 with psycopg", "Port the SQL"] }],
  dataFiles: ["app.db"],
};
const prisma = { matches: [{ framework: "prisma", action: "auto" as const, files: ["prisma/schema.prisma"] }], dataFiles: [] };

describe("localDatabaseGuard", () => {
  it("refuses a dynamic app with a local database and no managed one", () => {
    const r = localDatabaseGuard(node, rawSqlite)!;
    expect(r.errorCode).toBe("local_database_detected");
    expect(r.frameworks).toEqual(["python-raw"]);
    expect(r.files).toEqual(["app/db.py"]);
    expect(r.error).toMatch(/wiped every time the app sleeps/);
  });

  it("turns a warn-level match into porting steps the agent can follow, then the manifest flip", () => {
    const steps = localDatabaseGuard(node, rawSqlite)!.nextSteps.join("\n");
    expect(steps).toMatch(/Port python-raw \(app\/db\.py\) to Postgres yourself/);
    expect(steps).toContain("  - Replace sqlite3 with psycopg");
    expect(steps).toMatch(/"requiresDatabase": true/);
    expect(steps).toMatch(/"persistence": "ephemeral"/);
  });

  it("points an auto-level match at migrate-db.mjs rather than hand-porting", () => {
    const steps = localDatabaseGuard(node, prisma)!.nextSteps.join("\n");
    expect(steps).toMatch(/Run migrate-db\.mjs — it rewires prisma/);
    expect(steps).not.toMatch(/yourself/);
  });

  it("lets through: nothing detected, a managed database, a static site, or an explicit opt-out", () => {
    expect(localDatabaseGuard(node, { matches: [], dataFiles: [] })).toBeNull();
    expect(localDatabaseGuard({ ...node, requiresDatabase: true }, rawSqlite)).toBeNull();
    expect(localDatabaseGuard({ ...node, runtime: "static", resourceClass: "static" }, rawSqlite)).toBeNull();
    expect(localDatabaseGuard({ ...node, persistence: "ephemeral" }, rawSqlite)).toBeNull();
  });

  // Data already in the file is deliberately not the guard's business.
  it("says nothing about the rows already in the local file", () => {
    const r = localDatabaseGuard(node, rawSqlite)!;
    expect(JSON.stringify(r)).not.toMatch(/app\.db|dataAtRisk|copy|import/i);
  });
});

describe("detection reaches the common vibe-coder defaults", () => {
  it("go.mod with a SQLite driver", () => {
    const d = detectPersistence([file("go.mod", "module x\n\nrequire github.com/mattn/go-sqlite3 v1.14.22\n")]);
    expect(d.matches[0]).toMatchObject({ framework: "go-raw", action: "warn" });
    expect(d.matches[0].nextSteps!.join("\n")).toMatch(/pgx/);
  });
  it("libsql in package.json", () => {
    const d = detectPersistence([file("package.json", JSON.stringify({ dependencies: { "@libsql/client": "^0.6.0" } }))]);
    expect(d.matches[0]).toMatchObject({ framework: "node-raw", action: "warn" });
  });
});

/**
 * End to end: deploy.mjs must refuse BEFORE touching the network. The API here
 * is a dead port, so a deploy that got as far as POST /api/deploy would report
 * `unreachable` instead.
 */
describe("deploy.mjs refuses before upload", () => {
  function repo(manifest: Record<string, unknown>, files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "tamari-guard-"));
    writeFileSync(join(dir, "tamari.json"), JSON.stringify(manifest));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    return dir;
  }
  const env = { ...process.env, TAMARI_API: "http://127.0.0.1:9", TAMARI_TOKEN: "t" };
  const run = (dir: string) => {
    const r = spawnSync(process.execPath, [join(process.cwd(), "skills/tamari/deploy.mjs")], { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
    return JSON.parse(r.stdout) as { ok: boolean; errorCode: string; nextSteps?: string[] };
  };
  const python = { app: "x", name: "X", runtime: "python", resourceClass: "personal", healthPath: "/healthz", requiresDatabase: false };
  const sqliteApp = { "app/db.py": 'import sqlite3\nconn = sqlite3.connect("app.db")\n', "requirements.txt": "flask\n" };

  it("stops a SQLite app with local_database_detected, not unreachable", () => {
    const out = run(repo(python, sqliteApp));
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("local_database_detected");
    expect(out.nextSteps!.length).toBeGreaterThan(2);
  });

  it("proceeds to the network once requiresDatabase is true", () => {
    expect(run(repo({ ...python, requiresDatabase: true }, sqliteApp)).errorCode).toBe("unreachable");
  });

  it("proceeds for an explicit ephemeral opt-out", () => {
    expect(run(repo({ ...python, persistence: "ephemeral" }, sqliteApp)).errorCode).toBe("unreachable");
  });

  it("proceeds for an app with no local database", () => {
    expect(run(repo(python, { "app/main.py": "print('hi')\n" })).errorCode).toBe("unreachable");
  });
});
