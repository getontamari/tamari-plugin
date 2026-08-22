// @vitest-environment node
//
// optimize-startup is the pre-deploy step that conforms a Next.js app to the
// cheapest viable runtime (static export, else output:standalone). Every
// function is pure over an in-memory ProjectFile[] — no disk, no `next build` —
// so detection and the config rewrite are pinned exactly.

import { describe, expect, it } from "vitest";

import {
  classifyTarget,
  createNextConfig,
  detectNext,
  existingOutput,
  findNextConfig,
  hasOutputKey,
  planOptimization,
  scanDisqualifiers,
  setOutput,
  usesNextImage,
} from "../skills/tamari/optimize-startup.mjs";

const file = (path: string, content: string | null = "") => ({ path, content });
const pkg = (deps: Record<string, string>) =>
  file("package.json", JSON.stringify({ dependencies: deps }));

describe("detectNext", () => {
  it("is true when next is a dependency, false otherwise", () => {
    expect(detectNext([pkg({ next: "15.0.0" })])).toBe(true);
    expect(detectNext([pkg({ express: "4" })])).toBe(false);
    expect(detectNext([file("index.html", "<h1>hi</h1>")])).toBe(false);
  });
});

describe("findNextConfig / hasOutputKey", () => {
  it("locates a next.config and detects an existing output key", () => {
    const cfg = file("next.config.mjs", "export default { reactStrictMode: true };");
    expect(findNextConfig([cfg])?.path).toBe("next.config.mjs");
    expect(hasOutputKey(cfg.content!)).toBe(false);
    expect(hasOutputKey("export default { output: 'export' };")).toBe(true);
  });

});

describe("detectNext: package.json find predicate (content != null, not truthy)", () => {
  it("does not skip past an empty-but-present package.json to a later match, matching findNextConfig's null check", () => {
    // "" is falsy but readable (content != null). The old `&& p.content`
    // predicate would treat it as no-match and fall through to the second
    // package.json; the harmonized `&& p.content != null` predicate stops at
    // the first candidate, same as findNextConfig already does.
    const project = [
      file("package.json", ""),
      file("sub/package.json", JSON.stringify({ dependencies: { next: "15" } })),
    ];
    expect(detectNext(project)).toBe(false);
  });

  it("is unaffected for real, non-empty files", () => {
    expect(detectNext([pkg({ next: "15" })])).toBe(true);
    expect(detectNext([file("package.json", null)])).toBe(false);
  });
});

describe("existingOutput", () => {
  it("classifies export, standalone, other, and absent", () => {
    expect(existingOutput("export default { output: 'export' };")).toBe("export");
    expect(existingOutput('export default { output: "standalone" };')).toBe("standalone");
    expect(existingOutput("export default { reactStrictMode: true };")).toBeNull();
  });
});

describe("planOptimization: none", () => {
  it("returns none for a non-Next project, with no edits", () => {
    const { report, edits } = planOptimization([pkg({ express: "4" })]);
    expect(report.action).toBe("none");
    expect(edits).toEqual([]);
    expect(report).toMatchObject({ ok: true, changed: [], warnings: [], nextSteps: [] });
  });

  it("returns none when next.config already sets output: 'standalone' — respect the author, already a container", () => {
    const project = [pkg({ next: "15" }), file("next.config.mjs", "export default { output: 'standalone' };")];
    const { report, edits } = planOptimization(project);
    expect(report.action).toBe("none");
    expect(edits).toEqual([]);
  });
});

describe("planOptimization: output already set to 'export'", () => {
  it("routes static-export (not none) when next.config already declares output: 'export' — already a static site, must not be shipped as an empty container", () => {
    const project = [pkg({ next: "15" }), file("next.config.mjs", "export default { output: 'export' };")];
    const { report, edits } = planOptimization(project);
    expect(report.action).toBe("static-export");
    expect(report.publishDir).toBe("out");
    expect(edits).toEqual([]);
  });
});

describe("scanDisqualifiers", () => {
  it("finds nothing for a clean exportable app", () => {
    const project = [pkg({ next: "15" }), file("app/page.tsx", "export default function Page(){return null}")];
    expect(scanDisqualifiers(project)).toEqual([]);
    expect(classifyTarget(project)).toBe("export");
  });

  it("flags API route handlers", () => {
    const d = scanDisqualifiers([file("app/api/hello/route.ts", "export function GET(){}")]);
    expect(d.map((x) => x.reason).join()).toMatch(/API routes/);
    expect(classifyTarget([file("pages/api/x.js", "export default () => {}")])).toBe("standalone");
  });

  it("flags middleware", () => {
    expect(scanDisqualifiers([file("middleware.ts", "export function middleware(){}")])[0].reason).toMatch(/middleware/);
    expect(scanDisqualifiers([file("src/middleware.js", "export function middleware(){}")])[0].reason).toMatch(/middleware/);
  });

  it("flags server actions, getServerSideProps, ISR, force-dynamic, and next/headers", () => {
    expect(scanDisqualifiers([file("app/a.tsx", "'use server'\nexport async function act(){}")])[0].reason).toMatch(/server actions/);
    expect(scanDisqualifiers([file("pages/p.tsx", "export async function getServerSideProps(){return {props:{}}}")])[0].reason).toMatch(/SSR/);
    expect(scanDisqualifiers([file("app/a.tsx", "export const revalidate = 60")])[0].reason).toMatch(/revalidate|ISR/);
    expect(scanDisqualifiers([file("app/a.tsx", "export const dynamic = 'force-dynamic'")])[0].reason).toMatch(/dynamic/);
    expect(scanDisqualifiers([file("app/a.tsx", "import { cookies } from 'next/headers'")])[0].reason).toMatch(/next\/headers/);
  });
});

describe("usesNextImage", () => {
  it("detects next/image imports", () => {
    expect(usesNextImage([file("app/a.tsx", "import Image from 'next/image'")])).toBe(true);
    expect(usesNextImage([file("app/a.tsx", "export default () => null")])).toBe(false);
  });

  it("ignores a next/image mention in a non-source file (e.g. a README code snippet)", () => {
    const project = [file("README.md", "```tsx\nimport Image from 'next/image'\n```")];
    expect(usesNextImage(project)).toBe(false);
  });
});

describe("setOutput", () => {
  it("inserts output into export default, module.exports, and const shapes", () => {
    expect(setOutput("export default {\n  reactStrictMode: true,\n};", "export")!.newContent)
      .toContain('output: "export"');
    expect(setOutput("module.exports = {\n};", "standalone")!.newContent)
      .toContain('output: "standalone"');
    const named = setOutput("const nextConfig = {\n};\nexport default nextConfig;", "export", { unoptimizedImages: true })!;
    expect(named.newContent).toContain('output: "export"');
    expect(named.newContent).toContain("images: { unoptimized: true }");
  });

  it("returns null for an unrecognizable (function-wrapped) config", () => {
    expect(setOutput("export default defineConfig({ reactStrictMode: true });", "export")).toBeNull();
  });

  it("targets the exported identifier's own declaration, not an unrelated earlier object literal", () => {
    const content =
      "const securityHeaders = {\n  key: 'value',\n};\nconst nextConfig = {\n  reactStrictMode: true,\n};\nexport default nextConfig;\n";
    const r = setOutput(content, "export")!;
    // output must land inside nextConfig...
    const nextConfigStart = r.newContent.indexOf("const nextConfig = {");
    const outputIdx = r.newContent.indexOf('output: "export"');
    expect(outputIdx).toBeGreaterThan(nextConfigStart);
    // ...and must not have landed inside securityHeaders.
    expect(r.newContent.indexOf("securityHeaders = {\n  output")).toBe(-1);
    expect(r.newContent).toMatch(/const securityHeaders = \{\n {2}key: 'value',\n\};/);
  });

  it("resolves module.exports = <name> to that name's own const declaration", () => {
    const content = "const nextConfig = {\n  reactStrictMode: true,\n};\nmodule.exports = nextConfig;\n";
    const r = setOutput(content, "standalone")!;
    const nextConfigStart = r.newContent.indexOf("const nextConfig = {");
    const outputIdx = r.newContent.indexOf('output: "standalone"');
    expect(outputIdx).toBeGreaterThan(nextConfigStart);
    expect(outputIdx).toBeLessThan(r.newContent.indexOf("module.exports"));
  });
});

describe("createNextConfig", () => {
  it("creates next.config.mjs with the output key", () => {
    const c = createNextConfig("standalone");
    expect(c.path).toBe("next.config.mjs");
    expect(c.newContent).toContain('output: "standalone"');
  });
});

describe("planOptimization: full", () => {
  const nextPkg = pkg({ next: "15" });

  it("exportable app with a config → static-export, edits the config, publishDir out", () => {
    const project = [nextPkg, file("next.config.mjs", "export default {\n};"), file("app/page.tsx", "export default () => null")];
    const { report, edits } = planOptimization(project);
    expect(report.action).toBe("static-export");
    expect(report.publishDir).toBe("out");
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe("next.config.mjs");
    expect(edits[0].newContent).toContain('output: "export"');
  });

  it("exportable app using next/image → adds images.unoptimized", () => {
    const project = [nextPkg, file("next.config.mjs", "export default {\n};"), file("app/a.tsx", "import Image from 'next/image'")];
    expect(planOptimization(project).edits[0].newContent).toContain("images: { unoptimized: true }");
  });

  it("dynamic app (API routes) → standalone with a reason", () => {
    const project = [nextPkg, file("next.config.mjs", "export default {\n};"), file("app/api/x/route.ts", "export function GET(){}")];
    const { report, edits } = planOptimization(project);
    expect(report.action).toBe("standalone");
    expect(report.publishDir).toBeUndefined();
    expect(report.reason).toMatch(/container/);
    expect(edits[0].newContent).toContain('output: "standalone"');
  });

  it("no config present → creates next.config.mjs", () => {
    const project = [nextPkg, file("app/page.tsx", "export default () => null")];
    const { report, edits } = planOptimization(project);
    expect(report.action).toBe("static-export");
    expect(edits[0].path).toBe("next.config.mjs");
  });

  it("unparseable config → warn, no edits", () => {
    const project = [nextPkg, file("next.config.js", "module.exports = defineConfig({});"), file("app/page.tsx", "export default () => null")];
    const { report, edits } = planOptimization(project);
    expect(report.action).toBe("warn");
    expect(edits).toEqual([]);
    expect(report.nextSteps.length).toBeGreaterThan(0);
  });
});

describe("integration: playbook contract", () => {
  it("a clean Next app with next/image yields the static-export contract the SKILL.md relies on", () => {
    const project = [
      pkg({ next: "15" }),
      file("next.config.mjs", "export default {\n};"),
      file("app/page.tsx", "import Image from 'next/image'\nexport default () => null"),
    ];
    const { report, edits } = planOptimization(project);
    expect(report).toMatchObject({ ok: true, action: "static-export", publishDir: "out" });
    expect(report.changed[0].file).toBe("next.config.mjs");
    expect(edits[0].newContent).toContain('output: "export"');
    expect(edits[0].newContent).toContain("images: { unoptimized: true }");
  });
});
