// Local file writes are wiped on the same schedule as a local database, and
// nothing said so: a real app shipped its photos to disk through multer with
// every check passing. The database guard refuses; this only warns, because
// the same calls write build output and temp files and only the author knows
// which writes are user data.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localWritesNote } from "../skills/tamari/deploy.mjs";
import { NODE_PG_CHECKLIST, SQLITE_TO_POSTGRES_CHECKLIST, buildReport, detectLocalWrites, detectPersistence } from "../skills/tamari/migrate-db.mjs";

const file = (path: string, content: string) => ({ path, content, size: content.length });
const node = { app: "x", name: "X", runtime: "node", resourceClass: "personal", healthPath: "/healthz", requiresDatabase: true };

describe("detectLocalWrites", () => {
  it("finds the common ways an app writes user data to disk", () => {
    const d = detectLocalWrites([
      file("src/upload.js", 'const storage = multer.diskStorage({ destination: "uploads/" });'),
      file("src/photos.js", 'import fs from "node:fs";\nfs.writeFileSync(`data/${id}.jpg`, buf);'),
      file("src/save.mjs", 'import { writeFile } from "node:fs/promises";\nawait writeFile(path, bytes);'),
      file("src/app.js", 'app.use("/media", express.static("uploads"));'),
      file("app/views.py", 'f.save(os.path.join(app.config["UPLOAD_FOLDER"], name))'),
      file("main.go", 'os.WriteFile(filepath.Join("data", name), b, 0o644)'),
    ]);
    expect(d.files).toEqual([
      { path: "src/upload.js", pattern: "multer disk storage" },
      { path: "src/photos.js", pattern: "fs write" },
      { path: "src/save.mjs", pattern: "fs write" },
      { path: "src/app.js", pattern: "express.static over a data directory" },
      { path: "app/views.py", pattern: "file save" },
      { path: "main.go", pattern: "os write" },
    ]);
  });

  it("ignores writes that never run in the container: tests, scripts, tooling, docs", () => {
    const d = detectLocalWrites([
      file("test/photos.test.js", 'import fs from "node:fs";\nfs.writeFileSync("fixture.jpg", buf);'),
      file("scripts/seed.js", 'import fs from "node:fs";\nfs.writeFileSync("seed.json", "{}");'),
      file("vite.config.ts", 'import fs from "node:fs";\nfs.writeFileSync("x", "y");'),
      file("README.md", "call fs.writeFileSync to save the upload"),
      file("src/static.js", 'app.use(express.static("public"));'),
      file("src/read.js", 'import fs from "node:fs";\nconst t = fs.readFileSync("config.json");'),
    ]);
    expect(d.files).toEqual([]);
  });

  // A bare `writeFile(` is a common function name; only count it when the
  // file actually imports fs.
  it("does not mistake an unrelated writeFile for a disk write", () => {
    expect(detectLocalWrites([file("src/api.js", "await client.writeFile(bucket, key, body);")]).files).toEqual([]);
  });
});

describe("the migrate-db report carries the warning", () => {
  it("lists localWrites and warns about the wiped disk, without changing the action", () => {
    const project = [
      file("src/upload.js", 'const storage = multer.diskStorage({ destination: "uploads/" });'),
      file("package.json", JSON.stringify({ dependencies: { pg: "^8" } })),
    ];
    const detection = detectPersistence(project);
    expect(detection.localWrites).toEqual([{ path: "src/upload.js", pattern: "multer disk storage" }]);
    const report = buildReport(detection, []);
    expect(report.action).toBe("none");
    expect(report.localWrites).toEqual(detection.localWrites);
    expect(report.warnings.join("\n")).toMatch(/src\/upload\.js/);
    expect(report.warnings.join("\n")).toMatch(/no blob store/);
    expect(report.warnings.join("\n")).toMatch(/bytea/);
  });
});

describe("localWritesNote", () => {
  it("names the files and the fix, and stays quiet for a static site or a clean app", () => {
    const note = localWritesNote(node, { files: [{ path: "src/upload.js", pattern: "multer disk storage" }] })!;
    expect(note).toMatch(/src\/upload\.js \(multer disk storage\)/);
    expect(note).toMatch(/wiped every time the app sleeps/);
    expect(note).toMatch(/no blob store/);
    expect(note).toMatch(/Build output and temp files are fine/);
    expect(localWritesNote({ ...node, runtime: "static" }, { files: [{ path: "a", pattern: "b" }] })).toBeNull();
    expect(localWritesNote(node, { files: [] })).toBeNull();
    expect(localWritesNote(node, null)).toBeNull();
  });
});

/**
 * The node-raw next steps used to say "usually one file". They now carry what
 * the port actually hits; each item here broke a real app.
 */
describe("the SQLite → Postgres checklist", () => {
  const steps = detectPersistence([file("package.json", JSON.stringify({ dependencies: { "better-sqlite3": "^11" } }))]).matches[0].nextSteps!.join("\n");

  it("is honest about the async cascade", () => {
    expect(steps).toMatch(/synchronous and `pg` is asynchronous/);
    expect(steps).toMatch(/112 call sites/);
    expect(steps).not.toMatch(/usually one file/);
  });
  it.each([
    ["identity columns", /GENERATED BY DEFAULT AS IDENTITY/],
    ["forward references", /ALTER TABLE … ADD CONSTRAINT/],
    ["bigint as string", /setTypeParser\(20, Number\)/],
    ["numeric as string", /NUMERIC \(OID 1700\)/],
    ["COLLATE NOCASE and friends", /COLLATE NOCASE/],
    ["the INNER reserved word", /`AS inner` is a syntax error/],
    ["the INTEGER cap", /2,147,483,647/],
    ["NUL bytes", /22021/],
    ["transaction abort", /25P02/],
    ["connectionTimeoutMillis", /connectionTimeoutMillis/],
    ["Buffer vs Uint8Array", /Uint8Array/],
    ["dotfiles when listing by extension", /skip dotfiles/],
    ["bind before connect", /Bind PORT before connecting/],
    ["db-check", /db-check\.mjs/],
  ])("covers %s", (_label, pattern) => {
    expect(steps).toMatch(pattern);
  });

  it("shares the language-neutral half with the Go and Python detectors", () => {
    const go = detectPersistence([file("go.mod", "module x\nrequire github.com/mattn/go-sqlite3 v1.14.22\n")]).matches[0].nextSteps!;
    const py = detectPersistence([file("app.py", "import sqlite3\nconn = sqlite3.connect('x.db')")]).matches[0].nextSteps!;
    for (const item of SQLITE_TO_POSTGRES_CHECKLIST) {
      expect(go).toContain(item);
      expect(py).toContain(item);
    }
    for (const item of NODE_PG_CHECKLIST) expect(go).not.toContain(item);
  });
});

/** End to end: deploy.mjs emits the note before the (dead) network is touched. */
describe("deploy.mjs notes local writes before upload", () => {
  it("emits a note line and still proceeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "tamari-writes-"));
    writeFileSync(join(dir, "tamari.json"), JSON.stringify(node));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/upload.js"), 'const storage = multer.diskStorage({ destination: "uploads/" });\n');
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    const r = spawnSync(process.execPath, [join(process.cwd(), "skills/tamari/deploy.mjs")], {
      cwd: dir, env: { ...process.env, TAMARI_API: "http://127.0.0.1:9", TAMARI_TOKEN: "t" }, encoding: "utf8", timeout: 20_000,
    });
    const notes = r.stderr.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; note?: string }).filter((e) => e.t === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toMatch(/src\/upload\.js/);
    expect(JSON.parse(r.stdout).errorCode).toBe("unreachable");
  });
});
