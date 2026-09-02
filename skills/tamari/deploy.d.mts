// Types for the deploy skill. The script itself is plain ESM JavaScript so it can
// be run with `node` directly as a skill, without a build step. Only the pure,
// unit-tested helper is part of the public surface.

export interface DeployFailure {
  errorCode: string;
  error: string;
}

/**
 * Map a failed HTTP response to an agent-actionable { errorCode, error }.
 * `body` is the parsed JSON response (or null when there is none, e.g. a storage
 * PUT). A 5xx or a 401 is never reported as a project fault.
 */
export function classifyFailure(
  step: string,
  httpStatus: number,
  body: unknown,
): DeployFailure;

/**
 * When a static-export build has produced `out/`, the deploy is static and
 * uploads that directory — not the tracked source. Static-ness is a property of
 * this deploy invocation, never written to tamari.json.
 */
export function manifestForDeploy<T extends Record<string, unknown>>(
  manifest: T,
  publishDir: string | undefined,
): T & { runtime?: string; resourceClass?: string };

/** tar argv: the publish dir's contents when set, else the tracked file list. */
export function tarArgs(publishDir: string | null | undefined, archivePath: string): string[];

/** Human-readable byte size for status detail. Pure — unit-tested. */
export function humanBytes(n: number): string;

/** A single client-observable stage event. */
export interface StageEvent {
  stage: "queue" | "build" | "provision" | "publish" | "live" | "deploy";
  status: "start" | "ok" | "fail";
}

/**
 * Client-observable stage events for a status transition prev -> next.
 * `runtime` distinguishes the static fast-path (queued -> live) from the
 * dynamic path (queued -> building -> deploying -> live). Pure — unit tested.
 * Emits only stages the client can actually see; no fabricated substeps.
 */
export function stageEvents(prev: string, next: string, runtime: string): StageEvent[];

/** Tracked files (NUL-delimited) minus those deleted from the working tree. */
export function withoutDeleted(trackedZ: Buffer, deletedZ: Buffer): Buffer;

/** The refusal for an app whose data lives in a local database file, or null when it may deploy. */
export function localDatabaseGuard(
  manifest: { runtime?: string; requiresDatabase?: boolean; persistence?: string; [key: string]: unknown },
  detection: { matches: Array<{ framework: string; action: "auto" | "warn"; files: string[]; nextSteps?: string[] }>; [key: string]: unknown } | null | undefined,
): { errorCode: "local_database_detected"; error: string; frameworks: string[]; files: string[]; nextSteps: string[] } | null;

/**
 * Refuse to ship an npm lockfile that cannot install on the linux-x64 builder
 * (npm/cli#4828: a lockfile grown incrementally on another platform records no
 * Linux native optional packages). `fail` refuses the deploy — build-platform
 * names are missing; `note` is advisory — the gaps are on platforms this build
 * does not run; null means healthy, v1, or not an npm lockfile at all.
 */
export function lockfilePlatformPreflight(
  lock:
    | {
        lockfileVersion?: number;
        packages?: Record<string, { optionalDependencies?: Record<string, string>; [key: string]: unknown }>;
        [key: string]: unknown;
      }
    | null
    | undefined,
  lockfileName?: string,
):
  | {
      fail: {
        errorCode: "lockfile_platform_mismatch";
        error: string;
        missing: string[];
        alsoMissingOtherPlatforms?: string[];
        nextSteps: string[];
      };
    }
  | { note: string }
  | null;

/**
 * The refusal for an archive over the platform's upload limit, or null when it
 * may upload (within the limit, or no limit named). `kind` chooses the fix:
 * git-tracked files, or a static publish directory.
 */
export function archiveTooLarge(
  bytes: number,
  limit: number | undefined | null,
  kind: "tracked" | "publishDir",
): { errorCode: "source_too_large"; error: string; bytes: number; limit: number; nextSteps: string[] } | null;
