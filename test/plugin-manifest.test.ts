import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin packaging", () => {
  it("marketplace.json lists the tamari plugin and points at a real plugin root", () => {
    const m = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8"));
    expect(m.name).toBe("tamari");
    expect(Array.isArray(m.plugins)).toBe(true);
    const p = m.plugins.find((x: { name: string }) => x.name === "tamari");
    expect(p).toBeTruthy();
    expect(existsSync(`${p.source}/.claude-plugin/plugin.json`)).toBe(true);
    expect(existsSync(`${p.source}/.codex-plugin/plugin.json`)).toBe(true);
  });

  it("plugin.json is valid and self-consistent", () => {
    const p = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
    expect(p.name).toBe("tamari");
    expect(typeof p.version).toBe("string");
    expect(existsSync("skills/tamari/SKILL.md")).toBe(true);
  });

  it("ships a Codex manifest that exposes the existing Tamari skill", () => {
    const p = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8"));
    expect(p.name).toBe("tamari");
    expect(p.skills).toBe("./skills/");
    expect(existsSync(p.skills)).toBe(true);
    expect(existsSync(`${p.skills}/tamari/SKILL.md`)).toBe(true);
  });

  it("keeps the Claude Code and Codex package identities in sync", () => {
    const claude = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
    const codex = JSON.parse(readFileSync(".codex-plugin/plugin.json", "utf8"));

    expect(codex.name).toBe(claude.name);
    expect(codex.version).toBe(claude.version);
    expect(codex.description).toBe(claude.description);
    expect(codex.author).toEqual(claude.author);
    expect(codex.repository).toBe(claude.repository);
  });
});
