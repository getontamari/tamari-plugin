// @vitest-environment node
//
// `migrate-db.mjs` and `optimize-startup.mjs` rewrite
// next.config.*, settings.py, requirements.txt and schema.prisma in place,
// while SKILL.md promises the user that "every change is reversible with git".
// That promise only holds for a file git already has a copy of.

import { describe, expect, it } from "vitest";

import {
  dirtyTargets,
  uncommittedAmong,
  uncommittedWarning,
} from "../skills/tamari/git.mjs";

const z = (...entries: string[]) => entries.map((e) => `${e}\0`).join("");

describe("dirtyTargets", () => {
  it("finds a modified target", () => {
    expect(dirtyTargets(z(" M next.config.ts"), ["next.config.ts"])).toEqual(["next.config.ts"]);
  });

  // Untracked is as dangerous as modified: git has no copy either way.
  it("counts an untracked file, which git also could not restore", () => {
    expect(dirtyTargets(z("?? settings.py"), ["settings.py"])).toEqual(["settings.py"]);
  });

  it("counts a staged change", () => {
    expect(dirtyTargets(z("A  schema.prisma"), ["schema.prisma"])).toEqual(["schema.prisma"]);
  });

  // Silence means committed-and-unmodified, or not existing yet. Both are safe:
  // one is revertible, the other has nothing to lose.
  it("treats a path git says nothing about as safe", () => {
    expect(dirtyTargets("", ["next.config.ts"])).toEqual([]);
    expect(dirtyTargets(z(" M unrelated.ts"), ["next.config.ts"])).toEqual([]);
  });

  /**
   * The reason this parses NUL-separated output. Git *quotes and escapes* paths
   * in the newline form, so a filename with a space or a non-ASCII character
   * arrives as `"my config.ts"` — which never equals the plain path we hold,
   * and the guard would silently pass. Same class of mistake as splitting
   * `git ls-files` on newlines, the same bug two functions away.
   */
  it("matches paths that the newline format would have quoted", () => {
    expect(dirtyTargets(z(" M my config.ts"), ["my config.ts"])).toEqual(["my config.ts"]);
    expect(dirtyTargets(z(" M ünïcode.py"), ["ünïcode.py"])).toEqual(["ünïcode.py"]);
  });

  it("reports each path once and only the ones asked about", () => {
    const out = dirtyTargets(z(" M a.ts", "?? b.ts", " M c.ts"), ["a.ts", "b.ts"]);
    expect(out.sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("uncommittedAmong", () => {
  it("asks git only about the paths in question", () => {
    let asked: string[] = [];
    const run = (paths: string[]) => { asked = paths; return ""; };
    expect(uncommittedAmong(["next.config.ts"], run)).toEqual([]);
    expect(asked).toEqual(["next.config.ts"]);
  });

  it("does not shell out when there is nothing to write", () => {
    let called = false;
    uncommittedAmong([], () => { called = true; return ""; });
    expect(called).toBe(false);
  });

  /**
   * Null, not []. Outside a repository the question "could git restore this?"
   * has the answer "no", and returning an empty array would have said "yes,
   * everything is fine" — the failure mode this guard exists to prevent.
   */
  it("returns null rather than claiming clean when git cannot answer", () => {
    expect(uncommittedAmong(["a.ts"], () => { throw new Error("not a git repository"); })).toBeNull();
  });
});

describe("uncommittedWarning", () => {
  it("names the files rather than blaming the whole tree", () => {
    const w = uncommittedWarning(["next.config.ts", "package.json"]);
    expect(w.warning).toContain("next.config.ts, package.json");
    // The user almost certainly has unrelated work in progress; telling them to
    // commit everything would be wrong advice.
    expect(w.warning).toMatch(/other uncommitted work is fine/i);
    expect(w.nextSteps.join(" ")).toContain("git add next.config.ts, package.json");
  });

  it("agrees with itself about singular and plural", () => {
    expect(uncommittedWarning(["a.ts"]).warning).toContain("it has");
    expect(uncommittedWarning(["a.ts", "b.ts"]).warning).toContain("they have");
  });
});
