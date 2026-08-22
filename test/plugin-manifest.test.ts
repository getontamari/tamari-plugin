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
  });

  it("plugin.json is valid and self-consistent", () => {
    const p = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
    expect(p.name).toBe("tamari");
    expect(typeof p.version).toBe("string");
    expect(existsSync("skills/tamari/SKILL.md")).toBe(true);
  });
});
