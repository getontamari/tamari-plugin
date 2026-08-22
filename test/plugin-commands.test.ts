import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CMD_DIR = "commands";
const COMMANDS = ["deploy.md", "start.md", "share.md", "secrets.md", "delete.md", "status.md"];

describe("plugin commands", () => {
  it("ships exactly the commands the plugin documents", () => {
    expect(new Set(readdirSync(CMD_DIR).filter((f) => f.endsWith(".md")))).toEqual(new Set(COMMANDS));
  });
  for (const f of COMMANDS) {
    it(`${f} has frontmatter with a description`, () => {
      const src = readFileSync(`${CMD_DIR}/${f}`, "utf8");
      expect(src.startsWith("---")).toBe(true);
      expect(/\ndescription:\s*\S/.test(src)).toBe(true);
    });
  }
  it("SKILL.md declares name and description", () => {
    const s = readFileSync("skills/tamari/SKILL.md", "utf8");
    expect(/\nname:\s*tamari\b/.test(s)).toBe(true);
    expect(/\ndescription:/.test(s)).toBe(true);
  });
});

/**
 * Plain speech has to reach every capability.
 *
 * SKILL.md's frontmatter is model-invoked; `commands/*.md` are user-invoked
 * only, and the agent cannot type a slash command. So anything a customer
 * should be able to ask for in ordinary words has to be both *described* in the
 * frontmatter, so the skill activates, and *runnable* from the body.
 *
 * None of this proves activation, which is a model judgment and needs a real
 * session. It proves the two things that would make activation useless.
 */
describe("skill reachability", () => {
  const skill = readFileSync("skills/tamari/SKILL.md", "utf8");
  const all = readdirSync("skills/tamari").filter((f) => f.endsWith(".mjs"));

  // An entrypoint is a script you can run — it has the `process.argv[1]` main
  // guard. A file without one is a library (git.mjs), and requiring SKILL.md to
  // "document" it would be documenting something with no user-facing behaviour.
  // Keyed off the guard rather than a filename allowlist so a new command
  // cannot be added and quietly exempted.
  const isEntrypoint = (f: string) =>
    readFileSync(`skills/tamari/${f}`, "utf8").includes("process.argv[1]");
  const scripts = all.filter(isEntrypoint);

  it("has scripts to check, and every one of them is an entrypoint or a library", () => {
    expect(scripts.length).toBeGreaterThan(5);
    expect(all.length).toBeGreaterThanOrEqual(scripts.length);
  });

  // A script nobody can find is a capability the product does not have. The
  // body refers to them through the placeholder it tells the agent to resolve,
  // so the assertion is that the filename appears in a runnable command — not
  // that a particular path prefix does.
  it.each(scripts)("%s is runnable from the body", (script) => {
    expect(skill).toContain(`<scripts>/${script}`);
  });

  /**
   * $CLAUDE_PLUGIN_ROOT is expanded in `commands/*.md`, which Claude Code
   * processes, and is NOT set in the shell the agent runs commands in. A body
   * that told the agent to use it produced a failed first command and a hunt
   * for the directory — recoverable by a capable agent, and indistinguishable
   * from a broken plugin to anyone else.
   */
  it("does not tell the agent to use a variable the shell will not have", () => {
    const body = skill.split("---").slice(2).join("---");
    const invocations = body.match(/node "[^"]+"/g) ?? [];
    expect(invocations.length).toBeGreaterThan(5);
    for (const line of invocations) expect(line).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  // The commands are user-invoked and expanded before the agent sees them, so
  // there the variable is correct and must stay.
  it("keeps the variable in the slash commands, where it does work", () => {
    const withScripts = readdirSync(CMD_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(`${CMD_DIR}/${f}`, "utf8"))
      .filter((c) => c.includes(".mjs"));
    expect(withScripts.length).toBeGreaterThan(3);
    for (const c of withScripts) expect(c).toContain("CLAUDE_PLUGIN_ROOT");
  });

  const description = skill.split("---")[1] ?? "";

  // The description used to cover deploying and nothing else, so a user asking
  // to share an app or add a key would not activate the skill at all — and
  // post-deploy is most of their life with the product.
  it.each([
    ["sharing", /shar/i],
    ["access", /access/i],
    ["secrets or keys", /key|secret|environment variable/i],
    ["plans and quota", /plan/i],
    ["deleting", /delet/i],
    // "which account am I signed in as" has to activate the skill, or
    // the answer is a browser on a different device — possibly a different
    // account, which is the question.
    ["account identity", /signed in|account/i],
  ])("describes %s, not only deploying", (_label, pattern) => {
    expect(description).toMatch(pattern);
  });

  // Breadth without a boundary is worse than none: firing on "share this file"
  // in an unrelated project makes the plugin feel like it is barging in.
  it("anchors itself so it does not fire on unrelated work", () => {
    expect(description).toMatch(/tamari\.json|Tamari is named|deployed here/i);
  });
});
