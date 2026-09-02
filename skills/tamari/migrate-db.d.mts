export type ProjectFile = { path: string; content: string | null; size: number };
export type FrameworkMatch = {
  framework: string;
  action: "auto" | "warn";
  files: string[];
  reason?: string;
  nextSteps?: string[];
};
/** A file that writes to the app's own disk, and the first pattern that showed it. */
export type LocalWrite = { path: string; pattern: string };
export type Detection = { matches: FrameworkMatch[]; dataFiles: string[]; localWrites?: LocalWrite[] };
export type Edit = { path: string; newContent: string; summary: string };
export type Report = {
  ok: boolean;
  action: "none" | "auto" | "warn";
  changed: { file: string; summary: string }[];
  warnings: string[];
  requiresDatabaseSet: boolean;
  dataAtRisk: string[];
  localWrites: LocalWrite[];
  nextSteps: string[];
};

export const DETECTORS: Array<(project: ProjectFile[]) => FrameworkMatch | null>;
export const PLANNERS: Record<string, (project: ProjectFile[], match: FrameworkMatch) => Edit[]>;
/** What a SQLite → Postgres port hits in any language; every line broke a real port. */
export const SQLITE_TO_POSTGRES_CHECKLIST: string[];
/** The node-postgres (`pg`) specific half of that checklist. */
export const NODE_PG_CHECKLIST: string[];
export function dataFilesAtRisk(project: ProjectFile[]): string[];
/** Places the app writes to its own disk (advisory — never a refusal). Pure — unit-tested. */
export function detectLocalWrites(project: ProjectFile[]): { files: LocalWrite[] };
export function detectPersistence(project: ProjectFile[]): Detection;
export function buildReport(detection: Detection, edits: Edit[]): Report;
export function applyEdits(edits: Edit[], write?: (path: string, content: string) => void): void;
export function planAutoEdits(project: ProjectFile[], matches: FrameworkMatch[]): Edit[];
export function setRequiresDatabase(content: string): { newContent: string; summary: string } | null;
export function rewritePrisma(content: string): { newContent: string; summary: string } | null;
export function rewriteDjangoSettings(content: string): { newContent: string; summary: string } | null;
export function rewriteSqlAlchemy(content: string): { newContent: string; summary: string } | null;
export function addPythonDriver(
  content: string,
  packages: string[],
): { newContent: string; summary: string } | null;
export function withManifestFromDisk(project: ProjectFile[], diskContent: string | null): ProjectFile[];
export function classifyDiskFailure(
  phase: "read" | "write",
  err: unknown,
): { errorCode: string; error: string };

/** The injected DATABASE_URL normalised for Python drivers (postgresql:// scheme, sslmode=require). */
export const PY_DATABASE_URL: string;

/** The tracked files as ProjectFile[] (content null for binaries). Disk glue shared with deploy.mjs. */
export function readProject(): ProjectFile[];
