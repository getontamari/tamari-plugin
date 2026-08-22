#!/usr/bin/env node
// Tamari startup optimizer: before deploy, conform a Next.js app to the cheapest
// viable runtime. A statically-exportable app is set to output:'export' (and
// served static — zero cold start); one that must stay a container gets
// output:'standalone' (smaller image, faster cold start). Config only ever;
// static-ness is a deploy-time property (TAMARI_PUBLISH_DIR in deploy.mjs).
//
// Pure functions over an in-memory ProjectFile[] so detection and the rewrite
// unit-test with no disk and no `next build`. main() is the only disk glue,
// mirroring deploy.mjs / migrate-db.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { uncommittedAmong, uncommittedWarning } from "./git.mjs";

/** @typedef {{ path: string, content: string|null }} ProjectFile */
/** @typedef {{ path: string, newContent: string, summary: string }} Edit */
/** @typedef {{ ok: boolean, action: "none"|"static-export"|"standalone"|"warn", changed: {file:string,summary:string}[], publishDir?: string, warnings: string[], nextSteps: string[], reason?: string }} Report */

const NEXT_CONFIG = /(^|\/)next\.config\.(js|mjs|cjs|ts)$/;

/** True when `next` is a declared dependency. */
export function detectNext(project) {
  const pkg = project.find((p) => /(^|\/)package\.json$/.test(p.path) && p.content != null);
  if (!pkg) return false;
  try {
    const j = JSON.parse(pkg.content);
    return Boolean((j.dependencies ?? {}).next || (j.devDependencies ?? {}).next);
  } catch {
    return false;
  }
}

/** The project's next.config file, or null. */
export function findNextConfig(project) {
  return project.find((p) => NEXT_CONFIG.test(p.path) && p.content != null) ?? null;
}

/**
 * The declared `output` value in a config, or null if the key is absent.
 * "other" covers any value the optimizer doesn't special-case (e.g. a
 * variable or an unrecognized string) — still respected, still a no-op.
 */
export function existingOutput(content) {
  const m = /\boutput\s*:\s*(['"])(export|standalone)\1/.exec(content);
  if (m) return m[2];
  return /\boutput\s*:/.test(content) ? "other" : null;
}

/** Whether a config already declares an `output` key (respect the author → none). */
export function hasOutputKey(content) {
  return existingOutput(content) !== null;
}

function report(fields) {
  return {
    ok: true,
    action: fields.action,
    changed: fields.changed ?? [],
    ...(fields.publishDir ? { publishDir: fields.publishDir } : {}),
    warnings: fields.warnings ?? [],
    nextSteps: fields.nextSteps ?? [],
    ...(fields.reason ? { reason: fields.reason } : {}),
  };
}

const SRC = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Reasons `output: 'export'` cannot serve this app. Empty ⇒ exportable.
 * A cheap pre-filter — the export build is the ground truth (SKILL.md fallback).
 */
export function scanDisqualifiers(project) {
  const found = [];
  const byPath = (re) => project.find((p) => re.test(p.path));
  const bySrc = (re) => project.find((p) => SRC.test(p.path) && p.content && re.test(p.content));
  const push = (hit, reason) => hit && found.push({ reason, file: hit.path });

  push(byPath(/(^|\/)(app\/.*\/route\.(ts|tsx|js|jsx)|pages\/api\/.+)$/), "has API routes");
  push(byPath(/(^|\/)(src\/)?middleware\.(ts|js)$/), "has middleware");
  push(bySrc(/^\s*['"]use server['"]/m), "uses server actions");
  push(bySrc(/\bgetServerSideProps\b/), "uses getServerSideProps (SSR)");
  push(bySrc(/export\s+const\s+revalidate\b/), "uses ISR revalidate");
  push(bySrc(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/), "forces dynamic rendering");
  push(bySrc(/from\s+['"]next\/headers['"]/), "uses next/headers at runtime");
  return found;
}

/** Whether the app imports next/image (→ needs images.unoptimized under export). */
export function usesNextImage(project) {
  return project.some((p) => SRC.test(p.path) && p.content && /from\s+['"]next\/image['"]/.test(p.content));
}

/** "export" when nothing disqualifies it, else "standalone". */
export function classifyTarget(project) {
  return scanDisqualifiers(project).length === 0 ? "export" : "standalone";
}

// Anchors for a config that IS the object literal being exported. These are
// safe to try unconditionally — `module.exports = {` and `export default {`
// can only ever refer to one object, the one they introduce.
const DIRECT_OBJECT_ANCHORS = [
  /module\.exports\s*=\s*\{/,
  /export\s+default\s*\{/,
];

/**
 * The identifier assigned by `export default <name>` or
 * `module.exports = <name>` (a bare identifier, not an object literal or a
 * function call), or null.
 */
function exportedIdentifier(content) {
  const m =
    /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(content) ??
    /module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(content);
  return m ? m[1] : null;
}

/**
 * Insert `output` (and images.unoptimized) into the config object that is
 * ACTUALLY exported; null if it cannot be resolved with certainty.
 *
 * A file can define more than one `const x = {...}` (e.g. a `securityHeaders`
 * object alongside `nextConfig`), so anchoring to "the first object literal in
 * the file" can splice into the wrong one. When the config is exported by
 * name (`export default nextConfig` / `module.exports = nextConfig`), resolve
 * that identifier first and anchor to its own declaration. Only the two
 * direct-object forms fall back to a bare match, because there only one object
 * is possible. No fallback beyond that — a wrong-object write is worse than a
 * warn.
 */
export function setOutput(content, value, { unoptimizedImages } = {}) {
  const insert =
    `\n  output: ${JSON.stringify(value)},` +
    (unoptimizedImages ? `\n  images: { unoptimized: true },` : "");

  const anchors = [];
  const name = exportedIdentifier(content);
  if (name) anchors.push(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`));
  anchors.push(...DIRECT_OBJECT_ANCHORS);

  for (const anchor of anchors) {
    const m = anchor.exec(content);
    if (m) {
      const idx = m.index + m[0].length;
      return {
        newContent: content.slice(0, idx) + insert + content.slice(idx),
        summary: `set output: ${JSON.stringify(value)}` + (unoptimizedImages ? "; images.unoptimized" : ""),
      };
    }
  }
  return null;
}

/** A minimal next.config.mjs when the app has none. */
export function createNextConfig(value, { unoptimizedImages } = {}) {
  const imagesLine = unoptimizedImages ? `\n  images: { unoptimized: true },` : "";
  return {
    path: "next.config.mjs",
    newContent:
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  output: ${JSON.stringify(value)},${imagesLine}\n};\n\nexport default nextConfig;\n`,
    summary: `create next.config.mjs with output: ${JSON.stringify(value)}`,
  };
}

/**
 * Decide what to do and produce the edits + report: classify the app,
 * rewrite next.config to the cheapest viable `output` target (or create one
 * when absent), and warn without writing when the config shape can't be
 * edited safely.
 */
export function planOptimization(project) {
  if (!detectNext(project)) return { report: report({ action: "none" }), edits: [] };

  const config = findNextConfig(project);
  if (config) {
    const existing = existingOutput(config.content);
    // Already exported statically: nothing to edit, but this must still route
    // static — "deploy normally" would ship a container with nothing to run.
    if (existing === "export") {
      return { report: report({ action: "static-export", publishDir: "out" }), edits: [] };
    }
    // 'standalone' (or any other author-chosen value): already a container by
    // the author's own choice — respect it.
    if (existing) {
      return { report: report({ action: "none", reason: "next.config already sets output" }), edits: [] };
    }
  }

  const target = classifyTarget(project); // "export" | "standalone"
  const unoptimizedImages = target === "export" && usesNextImage(project);
  const reason =
    target === "standalone"
      ? `kept as a container: ${scanDisqualifiers(project).map((d) => d.reason).join(", ")}`
      : undefined;

  let edit;
  if (config) {
    const r = setOutput(config.content, target, { unoptimizedImages });
    if (!r) {
      return {
        report: report({
          action: "warn",
          reason: "next.config is not in a recognizable shape to edit safely",
          nextSteps: [
            `Add \`output: ${JSON.stringify(target)}\`${unoptimizedImages ? " and `images: { unoptimized: true }`" : ""} to your Next.js config, then redeploy.`,
          ],
        }),
        edits: [],
      };
    }
    edit = { path: config.path, newContent: r.newContent, summary: r.summary };
  } else {
    edit = createNextConfig(target, { unoptimizedImages });
  }

  const action = target === "export" ? "static-export" : "standalone";
  return {
    report: report({
      action,
      changed: [{ file: edit.path, summary: edit.summary }],
      publishDir: target === "export" ? "out" : undefined,
      reason,
    }),
    edits: [edit],
  };
}

/** Write each edit atomically (temp file + rename). */
export function applyEdits(edits, write = writeAtomic) {
  for (const e of edits) write(e.path, e.newContent);
}

function writeAtomic(path, content) {
  const tmp = `${path}.tamari-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function fail(code, message) {
  console.log(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
}

/** Read the tracked files into ProjectFile[]. Binary files (NUL byte) → content null. */
function readProject() {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return paths.map((path) => {
    let content = null;
    try {
      const text = readFileSync(path, "utf8");
      content = text.includes("\u0000") ? null : text; // a NUL byte ⇒ binary (e.g. a .db file)
    } catch {
      content = null;
    }
    return { path, content };
  });
}

async function main() {
  let project;
  try {
    project = readProject();
  } catch (err) {
    fail("not_a_repo", `Could not list the project's files: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { report: r, edits } = planOptimization(project);

  // Same guard as migrate-db: rewrite only what git could restore.
  const targets = [...new Set(edits.map((e) => e.path))];
  const blocked = uncommittedAmong(targets);
  if (blocked === null || blocked.length > 0) {
    const note = blocked === null
      ? {
          warning: "Not rewriting anything: this does not look like a git repository, so no edit here could be undone.",
          nextSteps: ["Run `git init` and commit the project first, then run this again."],
        }
      : uncommittedWarning(blocked);
    console.log(JSON.stringify({
      ...r,
      action: "warn",
      changed: [],
      warnings: [...(r.warnings ?? []), note.warning],
      nextSteps: [...(r.nextSteps ?? []), ...note.nextSteps],
    }, null, 2));
    return;
  }

  try {
    applyEdits(edits);
  } catch (err) {
    fail("write_failed", `${err?.path ?? "config"}: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(JSON.stringify(r, null, 2));
}

// Run only as the CLI, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
