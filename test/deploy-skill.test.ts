// @vitest-environment node
//
// The deploy skill is the one file the agent actually reads on failure, and it
// acts on `errorCode`. These pin the response→errorCode mapping so a server-side
// failure can never again masquerade as a manifest problem the agent would
// "fix" in a loop. No network: classifyFailure is pure.

import { describe, expect, it } from "vitest";

import { classifyFailure, manifestForDeploy, tarArgs, stageEvents, humanBytes, withoutDeleted } from "../skills/tamari/deploy.mjs";
import { resolveToken } from "../skills/tamari/login.mjs";
import { parseSecretsArgs, readSecretValue } from "../skills/tamari/secrets.mjs";

describe("classifyFailure", () => {
  // The bug from the first real /deploy: a 503 was reported as invalid_manifest.
  it("reports a 5xx as a server problem, not a manifest problem", () => {
    const result = classifyFailure("deploy", 503, { error: "service unavailable" });
    expect(result.errorCode).toBe("server_error");
    expect(result.errorCode).not.toBe("invalid_manifest");
    expect(result.error).toContain("503");
    expect(result.error).toMatch(/do not modify the project/i);
  });

  it("reports a 5xx even when the body is empty or not JSON", () => {
    expect(classifyFailure("deploy", 502, {}).errorCode).toBe("server_error");
    expect(classifyFailure("poll", 500, null).errorCode).toBe("server_error");
  });

  it("maps 401 to not_signed_in, never a project fault", () => {
    const result = classifyFailure("deploy", 401, { error: "not signed in" });
    expect(result.errorCode).toBe("not_signed_in");
  });

  it("classifies a real invalid manifest from the issues list", () => {
    const result = classifyFailure("deploy", 400, {
      error: "invalid manifest",
      issues: [
        { field: "app", message: "must be a DNS label" },
        { field: "runtime", message: "unknown runtime" },
      ],
    });
    expect(result.errorCode).toBe("invalid_manifest");
    expect(result.error).toContain("app: must be a DNS label");
    expect(result.error).toContain("runtime: unknown runtime");
  });

  it("trusts a specific errorCode the server sent", () => {
    expect(
      classifyFailure("deploy", 409, { error: "taken", errorCode: "app_id_unavailable" }).errorCode,
    ).toBe("app_id_unavailable");
    expect(
      classifyFailure("start", 422, { error: "no index.html", errorCode: "static_publish_failed" })
        .errorCode,
    ).toBe("static_publish_failed");
  });

  // A server code wins even over a body that also carries issues, so the
  // specific cause is not lost.
  it("prefers a manifest issues list only when there is no server code", () => {
    const result = classifyFailure("deploy", 409, {
      errorCode: "app_unavailable",
      error: "suspended",
    });
    expect(result.errorCode).toBe("app_unavailable");
  });

  it("surfaces an uncoded 4xx honestly, keyed by step, with the HTTP status", () => {
    const result = classifyFailure("start", 409, { error: "deployment is already building" });
    expect(result.errorCode).toBe("start_failed");
    expect(result.error).toContain("409");
    expect(result.error).toContain("already building");
  });

  // A storage PUT has no JSON body; a 5xx there is still a server problem, a 4xx
  // (an expired signed URL) is a retriable upload failure.
  it("classifies a bodyless storage failure by status", () => {
    expect(classifyFailure("upload", 500, null).errorCode).toBe("server_error");
    expect(classifyFailure("upload", 403, null).errorCode).toBe("upload_failed");
  });
});

describe("credential resolution", () => {
  const fileToken = () => JSON.stringify({ token: "sz_fromfile" });

  it("prefers TAMARI_TOKEN over the credential file (CI override)", () => {
    expect(resolveToken({ TAMARI_TOKEN: "sz_env" }, () => fileToken())).toBe("sz_env");
  });
  it("falls back to the credential file when the env var is unset", () => {
    expect(resolveToken({}, () => fileToken())).toBe("sz_fromfile");
  });
  it("returns null when neither is present", () => {
    expect(resolveToken({}, () => { throw new Error("ENOENT"); })).toBeNull();
  });
});

describe("static-export publish path (TAMARI_PUBLISH_DIR)", () => {
  const base = { app: "site", name: "Site", runtime: "node", resourceClass: "personal", healthPath: "/healthz", requiresDatabase: false };

  it("forces runtime and resourceClass to static when a publish dir is set", () => {
    const out = manifestForDeploy(base, "out");
    expect(out.runtime).toBe("static");
    expect(out.resourceClass).toBe("static");
    expect(out.app).toBe("site"); // other fields preserved
  });

  it("leaves the manifest untouched when no publish dir is set", () => {
    expect(manifestForDeploy(base, undefined)).toEqual(base);
  });

  it("tars the publish dir's contents when it is set", () => {
    expect(tarArgs("out", "/tmp/x/source.tgz")).toEqual(["-czf", "/tmp/x/source.tgz", "-C", "out", "."]);
  });

  /**
   * This test previously asserted the vulnerable shape —
   * filenames spliced straight into argv — which is how the bug survived
   * review: it was pinned by a passing test.
   *
   * `tar` parses its own leading-dash arguments as options, so a tracked file
   * named `--use-compress-program=<cmd>` executed that command on the
   * developer's machine. `execFileSync` stops the *shell* interpreting
   * anything and was never the relevant boundary.
   *
   * The property worth asserting is not "there is a -- separator" but "no
   * filename reaches argv at all": names arrive on stdin, NUL-delimited.
   */
  it("never puts a tracked filename in argv — names come from stdin", () => {
    const args = tarArgs(null, "/tmp/x/source.tgz");
    expect(args).toEqual(["-czf", "/tmp/x/source.tgz", "--null", "-T", "-"]);
    expect(args).not.toContain("a.js");
    // The hostile case: nothing here can be read as an option by tar.
    expect(args.filter((a) => a.startsWith("--"))).toEqual(["--null"]);
  });

  // The archive path is passed in rather than fixed at /tmp/tamari-source.tgz
  // so a shared host cannot pre-plant a symlink over it.
  it("writes wherever it is told, not to a predictable path", () => {
    expect(tarArgs(null, "/tmp/tamari-abc123/source.tgz")[1]).toBe("/tmp/tamari-abc123/source.tgz");
    expect(JSON.stringify(tarArgs(null, "/tmp/tamari-abc123/source.tgz"))).not.toContain("tamari-source.tgz");
  });
});

describe("stageEvents (honest, client-observable stages)", () => {
  it("queued → building starts the build", () => {
    expect(stageEvents("queued", "building", "node")).toEqual([{ stage: "build", status: "start" }]);
  });
  it("building → deploying finishes build and starts provision", () => {
    expect(stageEvents("building", "deploying", "node")).toEqual([
      { stage: "build", status: "ok" },
      { stage: "provision", status: "start" },
    ]);
  });
  it("deploying → live finishes provision and goes live", () => {
    expect(stageEvents("deploying", "live", "node")).toEqual([
      { stage: "provision", status: "ok" },
      { stage: "live", status: "ok" },
    ]);
  });
  it("static goes queued → live via publish", () => {
    expect(stageEvents("queued", "live", "static")).toEqual([
      { stage: "publish", status: "ok" },
      { stage: "live", status: "ok" },
    ]);
  });
  it("a failure attributes to the stage it was in", () => {
    expect(stageEvents("building", "failed", "node")).toEqual([{ stage: "build", status: "fail" }]);
    expect(stageEvents("deploying", "failed", "node")).toEqual([{ stage: "provision", status: "fail" }]);
  });
  it("no status change emits nothing", () => {
    expect(stageEvents("building", "building", "node")).toEqual([]);
  });

  it("deploying → verifying finishes provision and starts app startup", () => {
    expect(stageEvents("deploying", "verifying", "node")).toEqual([
      { stage: "provision", status: "ok" },
      { stage: "startup", status: "start" },
    ]);
  });

  it("verifying → live finishes startup and goes live", () => {
    expect(stageEvents("verifying", "live", "node")).toEqual([
      { stage: "startup", status: "ok" },
      { stage: "live", status: "ok" },
    ]);
  });

  it("a failure while verifying attributes to the startup stage", () => {
    expect(stageEvents("verifying", "failed", "node")).toEqual([
      { stage: "startup", status: "fail" },
    ]);
  });
});

describe("humanBytes", () => {
  it("formats bytes, KB, and MB", () => {
    expect(humanBytes(500)).toBe("500 B");
    expect(humanBytes(2202009)).toBe("2.1 MB");
    expect(humanBytes(1024)).toBe("1.0 KB");
  });
});

describe("parseSecretsArgs", () => {
  it("parses list and unset", () => {
    expect(parseSecretsArgs(["list"])).toEqual({ cmd: "list" });
    expect(parseSecretsArgs(["unset", "API_KEY"])).toEqual({ cmd: "unset", key: "API_KEY" });
  });

  it("takes the value by reference, never by argument", () => {
    expect(parseSecretsArgs(["set", "API_KEY", "--from-file", "/tmp/k"]))
      .toEqual({ cmd: "set", key: "API_KEY", from: { kind: "file", path: "/tmp/k" } });
    expect(parseSecretsArgs(["set", "API_KEY", "--from-env=CI_SECRET"]))
      .toEqual({ cmd: "set", key: "API_KEY", from: { kind: "env", name: "CI_SECRET" } });
    expect(parseSecretsArgs(["set", "API_KEY", "--stdin"]))
      .toEqual({ cmd: "set", key: "API_KEY", from: { kind: "stdin" } });
  });

  /**
   * `set KEY=value` put the plaintext in `process.argv`:
   * readable by any local user via `ps`, written to shell history, and — since
   * an agent runs this through a shell tool — captured in the session
   * transcript and the model's context. The first two are hygiene; the third
   * cannot be undone once it has happened.
   */
  it("refuses KEY=value outright, and explains why", () => {
    const r = parseSecretsArgs(["set", "API_KEY=sk_live_secret"]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/visible to every process|shell history|agent transcript/i);
  });

  // The refusal must not echo the thing it is refusing to handle.
  it("does not repeat the secret back in the error", () => {
    const r = parseSecretsArgs(["set", "API_KEY=sk_live_supersecret"]) as { error: string };
    expect(r.error).not.toContain("sk_live_supersecret");
  });

  it("errors on a bad command, a missing key, or two sources", () => {
    expect(parseSecretsArgs(["frobnicate"])).toHaveProperty("error");
    expect(parseSecretsArgs(["set"])).toHaveProperty("error");
    expect(parseSecretsArgs(["set", "API_KEY"])).toHaveProperty("error");
    expect(parseSecretsArgs(["unset"])).toHaveProperty("error");
    expect(parseSecretsArgs(["set", "K", "--stdin", "--from-env", "V"])).toHaveProperty("error");
  });
});

describe("readSecretValue", () => {
  const deps = (over = {}) => ({
    readFile: () => { throw new Error("no file"); },
    env: {},
    readStdin: () => null,
    ...over,
  });

  it("reads from a file and from the environment", () => {
    expect(readSecretValue({ kind: "file", path: "/k" }, deps({ readFile: () => "sk_live_x" })))
      .toEqual({ value: "sk_live_x" });
    expect(readSecretValue({ kind: "env", name: "V" }, deps({ env: { V: "from-env" } })))
      .toEqual({ value: "from-env" });
  });

  // A file written with `echo` ends in a newline that is not part of the key.
  it("strips exactly one trailing newline, and nothing else", () => {
    expect(readSecretValue({ kind: "file", path: "/k" }, deps({ readFile: () => "abc\n" })).value).toBe("abc");
    expect(readSecretValue({ kind: "file", path: "/k" }, deps({ readFile: () => "abc\n\n" })).value).toBe("abc\n");
    // Some keys legitimately end in a space. Trimming it produces a value that
    // fails authentication somewhere far away with no clue why.
    expect(readSecretValue({ kind: "file", path: "/k" }, deps({ readFile: () => "abc " })).value).toBe("abc ");
  });

  it("reports a typed failure rather than throwing with the value attached", () => {
    expect(readSecretValue({ kind: "file", path: "/nope" }, deps())).toEqual({ error: "Cannot read /nope." });
    expect(readSecretValue({ kind: "env", name: "MISSING" }, deps()).error).toMatch(/\$MISSING is not set/);
    expect(readSecretValue({ kind: "stdin" }, deps()).error).toMatch(/Nothing arrived on stdin/);
    expect(readSecretValue({ kind: "stdin" }, deps({ readStdin: () => "" })).error).toMatch(/Nothing arrived/);
  });

  it("accepts a piped value", () => {
    expect(readSecretValue({ kind: "stdin" }, deps({ readStdin: () => "piped\n" }))).toEqual({ value: "piped" });
  });
});

// A file `rm`-ed but not yet `git rm`-ed is still in the index; tar then
// fails on "Cannot stat" and the deploy died with a stack trace.
describe("withoutDeleted", () => {
  const z = (...names: string[]) => Buffer.from(names.map((n) => `${n}\0`).join(""), "utf8");

  it("drops paths git reports as deleted from the working tree", () => {
    expect(withoutDeleted(z("a.txt", "src/b.js", "c.md"), z("src/b.js")).toString("utf8")).toBe("a.txt\0c.md\0");
  });
  it("returns the input untouched when nothing is deleted", () => {
    const tracked = z("a.txt", "b.txt");
    expect(withoutDeleted(tracked, Buffer.alloc(0))).toBe(tracked);
  });
  it("keeps a path containing a newline intact (NUL-delimited on both sides)", () => {
    expect(withoutDeleted(z("odd\nname.txt", "gone.txt"), z("gone.txt")).toString("utf8")).toBe("odd\nname.txt\0");
  });
  it("yields nothing when every tracked file is deleted, so deploy can refuse", () => {
    expect(withoutDeleted(z("a"), z("a")).length).toBe(0);
  });
});
