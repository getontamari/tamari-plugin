// deploy.mjs refuses to upload an npm lockfile the builder cannot install.
//
// npm/cli#4828: an incremental `npm install` on one platform can record only
// that platform's native optional packages in package-lock.json. The builder
// is linux-x64 and installs strictly from the lockfile, so the missing Linux
// binary fails the build a ~90-second cloud round trip later — with the same
// remediation this check prints in milliseconds, before anything leaves the
// machine. The platform classifies the same failure from the build log under
// the same code; this is the client half: same code, same fix.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lockfilePlatformPreflight } from "../skills/tamari/deploy.mjs";

// The two families from the real failure, complete with their real naming
// schemes — oxide's napi-rs style (`-linux-x64-gnu`) and workerd's bare
// `-linux-64` — because the platform match has to hit both.
const OXIDE_VARIANTS = [
  "@tailwindcss/oxide-android-arm64",
  "@tailwindcss/oxide-darwin-arm64",
  "@tailwindcss/oxide-darwin-x64",
  "@tailwindcss/oxide-freebsd-x64",
  "@tailwindcss/oxide-linux-arm-gnueabihf",
  "@tailwindcss/oxide-linux-arm64-gnu",
  "@tailwindcss/oxide-linux-arm64-musl",
  "@tailwindcss/oxide-linux-x64-gnu",
  "@tailwindcss/oxide-linux-x64-musl",
  "@tailwindcss/oxide-wasm32-wasi",
  "@tailwindcss/oxide-win32-arm64-msvc",
  "@tailwindcss/oxide-win32-x64-msvc",
];
const WORKERD_VARIANTS = [
  "@cloudflare/workerd-darwin-64",
  "@cloudflare/workerd-darwin-arm64",
  "@cloudflare/workerd-linux-64",
  "@cloudflare/workerd-linux-arm64",
  "@cloudflare/workerd-windows-64",
];

const optional = (names: string[]) => Object.fromEntries(names.map((n) => [n, "*"]));
const recorded = (names: string[]) =>
  Object.fromEntries(names.map((n) => [`node_modules/${n}`, { version: "1.0.0" }]));

/**
 * The incident shape: both families declare every variant, but only the
 * darwin-arm64 copy was ever recorded — an incremental install on an ARM Mac.
 */
const macGrownLock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/@tailwindcss/oxide": { optionalDependencies: optional(OXIDE_VARIANTS) },
    ...recorded(["@tailwindcss/oxide-darwin-arm64"]),
    "node_modules/workerd": { optionalDependencies: optional(WORKERD_VARIANTS) },
    ...recorded(["@cloudflare/workerd-darwin-arm64"]),
  },
};

/** Freshly resolved: every declared variant recorded; `npm ci` skips the foreign ones itself. */
const freshLock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/@tailwindcss/oxide": { optionalDependencies: optional(OXIDE_VARIANTS) },
    ...recorded(OXIDE_VARIANTS),
    "node_modules/esbuild": {
      optionalDependencies: optional(["@esbuild/linux-x64", "@esbuild/darwin-arm64"]),
    },
    ...recorded(["@esbuild/linux-x64", "@esbuild/darwin-arm64"]),
  },
};

type Preflight = ReturnType<typeof lockfilePlatformPreflight>;
const failOf = (r: Preflight) => {
  if (!r || !("fail" in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.fail;
};
const noteOf = (r: Preflight) => {
  if (!r || !("note" in r)) throw new Error(`expected a note, got ${JSON.stringify(r)}`);
  return r.note;
};

describe("lockfilePlatformPreflight", () => {
  it("refuses the mac-grown lockfile with the platform's code and the exact missing Linux names", () => {
    const fail = failOf(lockfilePlatformPreflight(macGrownLock));
    expect(fail.errorCode).toBe("lockfile_platform_mismatch");
    expect(fail.missing).toEqual([
      "@cloudflare/workerd-linux-64",
      "@tailwindcss/oxide-linux-x64-gnu",
      "@tailwindcss/oxide-linux-x64-musl",
    ]);
    // 15 declared-but-absent names in all: 11 oxide + 4 workerd.
    expect(fail.missing.length + (fail.alsoMissingOtherPlatforms?.length ?? 0)).toBe(15);
    expect(fail.error).toMatch(/generated on another platform/);
    expect(fail.error).toMatch(/npm\/cli#4828/);
    expect(fail.error).toMatch(/npm install/);
    expect(fail.nextSteps.join("\n")).toMatch(/commit/i);
  });

  it("passes a freshly resolved lockfile, including unsuffixed names like @esbuild/linux-x64", () => {
    expect(lockfilePlatformPreflight(freshLock)).toBeNull();
  });

  it("notes, but does not refuse, gaps only on platforms the builder does not run", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/sharp": {
          optionalDependencies: optional([
            "@img/sharp-win32-x64",
            "@img/sharp-linux-x64",
            "@img/sharp-linux-arm64",
          ]),
        },
        ...recorded(["@img/sharp-linux-x64"]),
      },
    };
    const note = noteOf(lockfilePlatformPreflight(lock));
    expect(note).toMatch(/@img\/sharp-win32-x64/);
    // linux-arm64 is another platform's gap, not this builder's.
    expect(note).toMatch(/@img\/sharp-linux-arm64/);
    expect(note).toMatch(/npm install/);
  });

  it("never hard-fails on linux-arm64 — the builder is x64", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/x": { optionalDependencies: optional(["x-linux-arm64-gnu", "x-linux-arm64"]) },
      },
    };
    const r = lockfilePlatformPreflight(lock);
    expect(r && "fail" in r).toBe(false);
    expect(r && "note" in r).toBe(true);
  });

  it("counts a name recorded anywhere in the tree — the check is by name, not resolution position", () => {
    const nestedRecord = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/lightningcss": {
          optionalDependencies: optional(["lightningcss-linux-x64-gnu"]),
        },
        "node_modules/vite/node_modules/lightningcss-linux-x64-gnu": { version: "1.0.0" },
      },
    };
    expect(lockfilePlatformPreflight(nestedRecord)).toBeNull();
  });

  it("has nothing to say about a v1 lockfile, an empty one, or a non-npm shape", () => {
    expect(lockfilePlatformPreflight({ lockfileVersion: 1, dependencies: {} })).toBeNull();
    expect(lockfilePlatformPreflight({ packages: {} })).toBeNull();
    expect(lockfilePlatformPreflight({})).toBeNull();
    expect(lockfilePlatformPreflight(null)).toBeNull();
  });

  it("names npm-shrinkwrap.json when that is the file being checked", () => {
    const fail = failOf(lockfilePlatformPreflight(macGrownLock, "npm-shrinkwrap.json"));
    expect(fail.error).toMatch(/npm-shrinkwrap\.json/);
    expect(fail.error).not.toMatch(/package-lock\.json/);
  });
});

/**
 * End to end: deploy.mjs must refuse BEFORE touching the network. The API here
 * is a dead port, so a deploy that got as far as POST /api/deploy would report
 * `unreachable` instead.
 */
describe("deploy.mjs refuses a mac-grown lockfile before upload", () => {
  const nodeManifest = {
    app: "x",
    name: "X",
    runtime: "node",
    resourceClass: "personal",
    healthPath: "/healthz",
    requiresDatabase: false,
  };
  const pkg = JSON.stringify({ name: "x", version: "1.0.0" });

  function repo(manifest: Record<string, unknown>, files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "tamari-lockfile-"));
    writeFileSync(join(dir, "tamari.json"), JSON.stringify(manifest));
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    return dir;
  }
  const env = { ...process.env, TAMARI_API: "http://127.0.0.1:9", TAMARI_TOKEN: "t" };
  const run = (dir: string) => {
    const r = spawnSync(process.execPath, [join(process.cwd(), "skills/tamari/deploy.mjs")], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    return {
      out: JSON.parse(r.stdout) as { ok: boolean; errorCode: string; missing?: string[] },
      stderr: r.stderr,
    };
  };

  it("stops with lockfile_platform_mismatch, not unreachable", () => {
    const { out } = run(
      repo(nodeManifest, {
        "package.json": pkg,
        "package-lock.json": JSON.stringify(macGrownLock),
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("lockfile_platform_mismatch");
    expect(out.missing).toContain("@tailwindcss/oxide-linux-x64-gnu");
  });

  it("proceeds to the network when the lockfile is healthy", () => {
    const { out } = run(
      repo(nodeManifest, { "package.json": pkg, "package-lock.json": JSON.stringify(freshLock) }),
    );
    expect(out.errorCode).toBe("unreachable");
  });

  it("proceeds when the broken lockfile is not tracked — the builder will never see it", () => {
    const { out } = run(
      repo(nodeManifest, {
        "package.json": pkg,
        "package-lock.json": JSON.stringify(macGrownLock),
        ".gitignore": "package-lock.json\n",
      }),
    );
    expect(out.errorCode).toBe("unreachable");
  });

  it("emits an advisory note and proceeds when only other platforms have gaps", () => {
    const otherOnly = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/x": { optionalDependencies: optional(["x-win32-x64-msvc"]) },
      },
    };
    const { out, stderr } = run(
      repo(nodeManifest, { "package.json": pkg, "package-lock.json": JSON.stringify(otherOnly) }),
    );
    expect(out.errorCode).toBe("unreachable");
    const note = stderr
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; note?: string })
      .find((l) => l.t === "note");
    expect(note?.note).toMatch(/x-win32-x64-msvc/);
  });

  it("does not check non-node runtimes", () => {
    const python = { ...nodeManifest, runtime: "python" };
    const { out } = run(
      repo(python, {
        "requirements.txt": "flask\n",
        "package-lock.json": JSON.stringify(macGrownLock),
      }),
    );
    expect(out.errorCode).toBe("unreachable");
  });
});
