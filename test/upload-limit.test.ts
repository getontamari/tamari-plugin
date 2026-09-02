// deploy.mjs refuses an archive the platform would reject on arrival, and
// sends the size limit the platform signs into the upload.
//
// The platform bounds what a deploy may upload. Storage enforces that with a
// signed `x-goog-content-length-range` header — but only when the client
// sends it, so the client has to say it will (`uploadLimit: true`) and then
// send back whatever `uploadHeaders` the begin response carries. Checking the
// archive locally first turns storage's bare 400 into the cause and the fix,
// before anything leaves the machine.

import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveTooLarge } from "../skills/tamari/deploy.mjs";

const MiB = 1024 * 1024;

describe("archiveTooLarge", () => {
  it("refuses an archive over the platform's limit with the cause and the fix", () => {
    const r = archiveTooLarge(300 * MiB, 128 * MiB, "tracked")!;
    expect(r.errorCode).toBe("source_too_large");
    expect(r.error).toMatch(/300 MiB/);
    expect(r.error).toMatch(/128 MiB/);
    expect(r.error).toMatch(/git-tracked/);
    expect(r.nextSteps.join("\n")).toMatch(/\.gitignore/);
    expect(r).toMatchObject({ bytes: 300 * MiB, limit: 128 * MiB });
  });

  it("names the export, not git, for a static publish directory", () => {
    const r = archiveTooLarge(300 * MiB, 128 * MiB, "publishDir")!;
    expect(r.error).not.toMatch(/git-tracked/);
    expect(r.error).toMatch(/export/);
  });

  it("lets through an archive within the limit, and any archive when the platform names no limit", () => {
    expect(archiveTooLarge(128 * MiB, 128 * MiB, "tracked")).toBeNull();
    expect(archiveTooLarge(300 * MiB, undefined, "tracked")).toBeNull();
    expect(archiveTooLarge(300 * MiB, 0, "tracked")).toBeNull();
  });
});

/**
 * End to end against a fake platform that records what the client sent. The
 * deployment is failed by the fake at the first status poll so the run ends
 * with a known code once the upload has been observed.
 */
describe("deploy.mjs and the upload limit", () => {
  let api: Server | undefined;
  afterEach(() => api?.close());

  type Seen = { begin?: Record<string, unknown>; put?: { headers: IncomingMessage["headers"]; bytes: number } };

  function fakePlatform(limitBytes: number): Promise<{ port: number; seen: Seen }> {
    const seen: Seen = {};
    api = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.method === "POST" && req.url === "/api/deploy") {
          seen.begin = JSON.parse(body.toString("utf8"));
          const port = (api!.address() as { port: number }).port;
          return json(200, {
            deploymentId: "d1",
            uploadUrl: `http://127.0.0.1:${port}/upload`,
            sourceUri: "gs://src/x/d1.tgz",
            uploadLimitBytes: limitBytes,
            uploadHeaders: { "x-goog-content-length-range": `0,${limitBytes}` },
          });
        }
        if (req.method === "PUT" && req.url === "/upload") {
          seen.put = { headers: req.headers, bytes: body.length };
          res.writeHead(200);
          return res.end();
        }
        if (req.method === "POST" && req.url === "/api/deployments/d1/start") return json(200, {});
        if (req.method === "GET" && req.url === "/api/deployments/d1") {
          return json(200, { status: "failed", errorCode: "build_failed", error: "fake platform stops here" });
        }
        json(404, { error: "unexpected request" });
      });
    });
    return new Promise((resolve) => {
      api!.listen(0, "127.0.0.1", () => {
        resolve({ port: (api!.address() as { port: number }).port, seen });
      });
    });
  }

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "tamari-upload-"));
    writeFileSync(join(dir, "tamari.json"), JSON.stringify({ app: "x", name: "X", runtime: "static", resourceClass: "static", healthPath: "/", requiresDatabase: false }));
    writeFileSync(join(dir, "index.html"), "<h1>hello</h1>\n".repeat(64));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    return dir;
  }

  // Asynchronous on purpose: the fake platform lives in this process, and a
  // spawnSync would block the event loop it needs to answer the child.
  function run(dir: string, port: number): Promise<{ ok: boolean; errorCode: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(process.cwd(), "skills/tamari/deploy.mjs")], {
        cwd: dir,
        env: { ...process.env, TAMARI_API: `http://127.0.0.1:${port}`, TAMARI_TOKEN: "t" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`deploy.mjs printed no result (code ${code}, signal ${signal}); stderr:\n${stderr}`));
        }
      });
    });
  }

  it("asks for the limit, and refuses an oversized archive before any upload", async () => {
    const { port, seen } = await fakePlatform(16);

    const out = await run(repo(), port);

    expect(seen.begin).toMatchObject({ uploadLimit: true });
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("source_too_large");
    expect(seen.put).toBeUndefined();
  });

  it("sends the signed size header with an upload inside the limit", async () => {
    const { port, seen } = await fakePlatform(64 * MiB);

    const out = await run(repo(), port);

    expect(seen.put?.headers["x-goog-content-length-range"]).toBe(`0,${64 * MiB}`);
    expect(seen.put?.headers["content-type"]).toBe("application/gzip");
    expect(seen.put?.bytes).toBeGreaterThan(0);
    // The fake platform fails the deployment at the first poll: the run ends
    // with its code, proving the upload step was passed rather than skipped.
    expect(out.errorCode).toBe("build_failed");
  });
});
