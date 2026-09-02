// The startup contract, as the plugin enforces and documents it.
//
// A real port took twelve deploys to reach a working app. Four of them were
// spent reverse-engineering what the platform checks at startup and at wake,
// three were spent obeying a failure table that filed a startup-probe failure
// under "not the project's fault", and every one of them reported `startup ok`
// while the app could not reach its database. These pin the three fixes: the
// reclassification, the post-live health probe, and the words in SKILL.md.

import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyDeployFailure, healthOutcome } from "../skills/tamari/deploy.mjs";

describe("classifyDeployFailure", () => {
  const probeMessage =
    "Revision 'x-00012' is not ready and cannot serve traffic. The user-provided container failed to start and listen on the port defined provided by the PORT=8080 environment variable. STARTUP TCP probe failed 1 time consecutively for container \"app\" on port 8080. The instance was not started.";

  // The row that sent an agent the wrong way for three deploys: the platform
  // reported this under provision_failed, and the table said do not touch the project.
  it("files a startup-probe failure as revision_failed whatever code it arrived under", () => {
    for (const code of ["provision_failed", "revision_failed", undefined, "build_failed"]) {
      const r = classifyDeployFailure(code, probeMessage);
      expect(r.errorCode, `from ${code}`).toBe("revision_failed");
      expect(r.error).toContain(probeMessage);
    }
    expect(classifyDeployFailure("provision_failed", "never reported a URI").errorCode).toBe("revision_failed");
  });

  it("attaches the fix the message never mentions", () => {
    const r = classifyDeployFailure("provision_failed", probeMessage);
    expect(r.error).toMatch(/TCP probe on \$PORT/);
    expect(r.error).toMatch(/awaiting a database connection/);
    expect(r.error).toMatch(/bind PORT first, on 0\.0\.0\.0/);
    expect(r.error).toMatch(/127\.0\.0\.1/);
  });

  it("leaves a genuine provisioning failure alone", () => {
    expect(classifyDeployFailure("provision_failed", "Cloud Run API quota exceeded for project")).toEqual({
      errorCode: "provision_failed",
      error: "Cloud Run API quota exceeded for project",
    });
    expect(classifyDeployFailure(undefined, undefined).errorCode).toBe("build_failed");
  });
});

describe("healthOutcome", () => {
  it("calls a 200 working", () => {
    expect(healthOutcome("/healthz", 200, '{"ok":true}')).toEqual({ path: "/healthz", status: 200, body: '{"ok":true}', ok: true });
  });
  // `startup ok` fired on every one of twelve deploys whose database was unreachable.
  it("calls anything else live-but-broken, and says why startup ok did not catch it", () => {
    const r = healthOutcome("/healthz", 503, '{"db":"connecting"}');
    expect(r.ok).toBe(false);
    expect((r as { warning: string }).warning).toMatch(/only saw the port open/);
    expect((r as { warning: string }).warning).toMatch(/every wake fails/);
    expect(healthOutcome("/healthz", null, "fetch failed").status).toBeNull();
  });
  it("flattens the body so an app cannot rewrite the terminal", () => {
    const esc = String.fromCharCode(27);
    expect(healthOutcome("/healthz", 200, `${esc}[2Jok\n${"x".repeat(1000)}`).body.length).toBeLessThanOrEqual(300);
    expect(healthOutcome("/healthz", 200, `${esc}[2Jok`).body).not.toContain(esc);
  });
});

/**
 * End to end: a fake platform takes the deploy to `live` and hands back a URL
 * that points at a fake app. The health stage and result have to reflect what
 * that app answers — not what the platform's TCP probe saw.
 */
describe("deploy.mjs probes the health path after live", () => {
  let api: Server | undefined;
  let app: Server | undefined;
  afterEach(() => { api?.close(); app?.close(); });

  function fakeApp(status: number, body: string): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = [];
    app = createServer((req, res) => {
      hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "none"}`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    return new Promise((resolve) => app!.listen(0, "127.0.0.1", () => resolve({ port: (app!.address() as { port: number }).port, hits })));
  }

  function fakePlatform(appUrl: string, failWith?: { errorCode: string; error: string }): Promise<number> {
    let polls = 0;
    api = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const port = (api!.address() as { port: number }).port;
        if (req.method === "POST" && req.url === "/api/deploy") return json(200, { deploymentId: "d1", uploadUrl: `http://127.0.0.1:${port}/upload` });
        if (req.method === "PUT" && req.url === "/upload") { res.writeHead(200); return res.end(); }
        if (req.method === "POST" && req.url === "/api/deployments/d1/start") return json(200, {});
        if (req.method === "GET" && req.url === "/api/deployments/d1") {
          polls += 1;
          if (failWith) return json(200, { status: "failed", ...failWith });
          const status = ["building", "deploying", "verifying", "live"][Math.min(polls - 1, 3)];
          return json(200, { status, url: appUrl, app: "x" });
        }
        json(404, { error: "unexpected request" });
      });
    });
    return new Promise((resolve) => api!.listen(0, "127.0.0.1", () => resolve((api!.address() as { port: number }).port)));
  }

  function repo(runtime = "node") {
    const dir = mkdtempSync(join(tmpdir(), "tamari-health-"));
    writeFileSync(join(dir, "tamari.json"), JSON.stringify({ app: "x", name: "X", runtime, resourceClass: "personal", healthPath: "/healthz", requiresDatabase: true }));
    writeFileSync(join(dir, "server.js"), "// bind first\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    return dir;
  }

  function run(dir: string, port: number): Promise<{ out: Record<string, unknown>; stages: Record<string, unknown>[] }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(process.cwd(), "skills/tamari/deploy.mjs")], {
        cwd: dir,
        env: { ...process.env, TAMARI_API: `http://127.0.0.1:${port}`, TAMARI_TOKEN: "t" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
      child.on("close", () => {
        clearTimeout(timer);
        const stages = stderr.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
        try { resolve({ out: JSON.parse(stdout), stages }); } catch { reject(new Error(`no JSON on stdout; stderr:\n${stderr}`)); }
      });
    });
  }

  it("reports a 200 health path as the working line, without sending a credential to the app", async () => {
    const { port: appPort, hits } = await fakeApp(200, '{"ok":true}');
    const port = await fakePlatform(`http://127.0.0.1:${appPort}`);
    const { out, stages } = await run(repo(), port);
    expect(out).toMatchObject({ ok: true, health: { path: "/healthz", status: 200, ok: true } });
    expect(out).not.toHaveProperty("warning");
    expect(hits).toEqual(["GET /healthz auth=none"]);
    expect(stages.find((s) => s.stage === "health")).toMatchObject({ t: "stage", status: "ok", detail: "GET /healthz → 200" });
    expect(stages.find((s) => s.stage === "startup" && s.status === "ok")).toBeDefined();
  }, 70_000);

  it("keeps the deploy live but flags a 503 health path as broken, with the body", async () => {
    const { port: appPort } = await fakeApp(503, '{"db":"connecting"}');
    const port = await fakePlatform(`http://127.0.0.1:${appPort}`);
    const { out, stages } = await run(repo(), port);
    expect(out.ok).toBe(true);
    expect(out.health).toMatchObject({ status: 503, ok: false, body: '{"db":"connecting"}' });
    expect(out.warning).toMatch(/live but GET \/healthz answered 503/);
    expect(stages.find((s) => s.stage === "health")).toMatchObject({ status: "fail", detail: "GET /healthz → 503" });
  }, 70_000);

  it("turns a provision_failed startup-probe message into revision_failed on the wire", async () => {
    const port = await fakePlatform("unused", {
      errorCode: "provision_failed",
      error: "STARTUP TCP probe failed 1 time consecutively for container \"app\" on port 8080. The instance was not started.",
    });
    const { out } = await run(repo(), port);
    expect(out).toMatchObject({ ok: false, errorCode: "revision_failed" });
    expect(out.error).toMatch(/bind PORT first/);
  }, 70_000);
});

/**
 * The words. An agent reads SKILL.md on failure, and these are the sentences
 * whose absence cost the deploys — pinned so a future edit cannot quietly drop them.
 */
describe("SKILL.md documents the startup contract precisely", () => {
  const skill = readFileSync("skills/tamari/SKILL.md", "utf8");
  const contract = skill.slice(skill.indexOf("**Startup contract.**"), skill.indexOf("5. **Identity.**"));

  it("names both checks and their protocols", () => {
    expect(contract).toMatch(/TCP probe on `\$PORT`/);
    expect(contract).toMatch(/HTTP GET on `healthPath`/);
    expect(contract).toMatch(/return \*\*200\*\*/);
  });
  it("says to bind before connecting, on 0.0.0.0", () => {
    expect(contract).toMatch(/bind before any async setup/i);
    expect(contract).toMatch(/0\.0\.0\.0/);
    expect(contract).toMatch(/127\.0\.0\.1/);
  });
  it("says a 503 health path fails every wake, and where the honest 503 belongs", () => {
    expect(contract).toMatch(/makes every wake fail/);
    expect(contract).toMatch(/data routes/);
  });
  it("tells the agent to log structured JSON with a severity field, up front", () => {
    expect(contract).toMatch(/one JSON object per line with a `severity` field/);
    expect(contract).toMatch(/levelled `DEFAULT`/);
  });
  it("tells the agent to skip dotfiles when listing by extension", () => {
    expect(contract).toMatch(/skip\s+dotfiles/);
    expect(contract).toMatch(/`\._name`/);
  });

  it("opens with the rule about absence in the log", () => {
    const top = skill.slice(0, skill.indexOf("## Where the scripts live"));
    expect(top).toMatch(/rests on something \*absent\* from the container log/);
    expect(top).toMatch(/by default it cannot/);
  });

  it("says what startup ok does and does not prove, and points at the health field", () => {
    expect(skill).toMatch(/`startup ok` means the port opened, nothing more/);
    expect(skill).toMatch(/`health\.status` 200 is the line that says the\s+app works/);
  });

  it("splits provision_failed by message and sends the probe case to revision_failed", () => {
    const row = skill.split("\n").find((l) => l.startsWith("| `provision_failed`"))!;
    expect(row).toMatch(/STARTUP TCP probe failed/);
    expect(row).toMatch(/revision_failed/);
    expect(row).toMatch(/awaiting the database before `listen\(\)`/);
    expect(row).toMatch(/do not modify the project/);
    const revision = skill.split("\n").find((l) => l.startsWith("| `revision_failed`"))!;
    expect(revision).toMatch(/most common cause is awaiting a database connection before binding `PORT`/);
  });

  it("documents sslmode=no-verify for every runtime, once", () => {
    expect(skill).toMatch(/`pg` turns into\s+`ssl: \{ rejectUnauthorized: false \}`/);
    expect(skill).toMatch(/psycopg[\s\S]*`sslmode=require`/);
    expect(skill).toMatch(/pgx accepts the URL as written/);
  });

  it("no longer calls a raw-driver port 'usually one file'", () => {
    expect(skill).not.toMatch(/usually one file/);
    expect(skill).toMatch(/not a find-and-replace/);
  });
});
