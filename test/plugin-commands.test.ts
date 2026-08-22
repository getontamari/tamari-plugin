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

  // A script nobody can find is a capability the product does not have.
  // `${CLAUDE_PLUGIN_ROOT}` — braces required — is substituted by Claude Code
  // in plugin skill markdown and in plugin command bodies before the model
  // sees them. The bare `$CLAUDE_PLUGIN_ROOT` is substituted by nothing and is
  // not exported to the Bash tool, so it reaches the shell empty and the path
  // becomes `/skills/tamari/login.mjs`. That was a real failure: every
  // /tamari:* command died with MODULE_NOT_FOUND on first use.
  const ROOT = "${CLAUDE_PLUGIN_ROOT}";
  const BARE = /\$CLAUDE_PLUGIN_ROOT(?![}\w])/;

  it.each(scripts)("%s is runnable from the skill body", (script) => {
    expect(skill).toContain(`node "${ROOT}/skills/tamari/${script}"`);
  });

  it("never uses the bare form, which the shell will not have", () => {
    expect(skill).not.toMatch(BARE);
    for (const f of readdirSync(CMD_DIR).filter((f) => f.endsWith(".md"))) {
      expect(readFileSync(`${CMD_DIR}/${f}`, "utf8"), f).not.toMatch(BARE);
    }
  });

  it("uses the braced form in every slash command that runs a script", () => {
    const withScripts = readdirSync(CMD_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(`${CMD_DIR}/${f}`, "utf8"))
      .filter((c) => c.includes(".mjs"));
    expect(withScripts.length).toBeGreaterThan(3);
    for (const c of withScripts) {
      for (const line of c.match(/node "[^"]+"/g) ?? []) expect(line).toContain(ROOT);
    }
  });

  // Guessing at the install path is how the old resolver broke: a glob inside
  // double quotes never expands. There is no need to resolve anything.
  it("does not tell the agent to go hunting for the scripts", () => {
    expect(skill).not.toMatch(/plugins\/cache/);
    expect(skill).not.toMatch(/<scripts>/);
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

/**
 * The sign-in link only helps if it reaches the person. Tool output does not;
 * the agent's own text does. Both places that describe the flow have to say
 * "relay `message` verbatim" and "end your turn" — a session where the agent
 * ran login.mjs and --wait back-to-back showed the user nothing at all.
 */
describe("sign-in instructions reach the user", () => {
  const docs = {
    "commands/deploy.md": readFileSync("commands/deploy.md", "utf8"),
    "skills/tamari/SKILL.md": readFileSync("skills/tamari/SKILL.md", "utf8"),
  };
  it.each(Object.entries(docs))("%s tells the agent to relay `message` verbatim and stop", (_f, text) => {
    expect(text).toMatch(/`message`[^\n]*verbatim/);
    expect(text).toMatch(/end your\s+turn/i);
    expect(text).toMatch(/not see tool output/i);
  });
});
