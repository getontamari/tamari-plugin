export type ProjectFile = { path: string; content: string | null };
export type Edit = { path: string; newContent: string; summary: string };
export type Report = {
  ok: boolean;
  action: "none" | "static-export" | "standalone" | "warn";
  changed: { file: string; summary: string }[];
  publishDir?: string;
  warnings: string[];
  nextSteps: string[];
  reason?: string;
};

export function detectNext(project: ProjectFile[]): boolean;
export function findNextConfig(project: ProjectFile[]): ProjectFile | null;
export function existingOutput(content: string): "export" | "standalone" | "other" | null;
export function hasOutputKey(content: string): boolean;
export function planOptimization(project: ProjectFile[]): { report: Report; edits: Edit[] };
export function applyEdits(edits: Edit[], write?: (path: string, content: string) => void): void;
export function scanDisqualifiers(project: ProjectFile[]): { reason: string; file: string }[];
export function usesNextImage(project: ProjectFile[]): boolean;
export function classifyTarget(project: ProjectFile[]): "export" | "standalone";
export function setOutput(
  content: string,
  value: "export" | "standalone",
  opts?: { unoptimizedImages?: boolean },
): { newContent: string; summary: string } | null;
export function createNextConfig(
  value: "export" | "standalone",
  opts?: { unoptimizedImages?: boolean },
): Edit;
