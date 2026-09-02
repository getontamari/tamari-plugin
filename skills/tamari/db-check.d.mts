// Types for the db-check skill. The script is plain ESM JavaScript (run
// directly with `node`); only the pure, unit-tested helpers are the public surface.

export type DbUrlSource = { kind: "env"; name: string } | { kind: "file"; path: string };

/** Parse argv (after the script name). A URL given as an argument is refused. Pure — unit-tested. */
export function parseDbCheckArgs(argv: string[]): { from: DbUrlSource } | { error: string };

/** The URL with its password replaced, for output. Pure — unit-tested. */
export function redactDatabaseUrl(url: string): string;

export type ConnectStage = "tcp" | "tls" | "auth" | "database" | "unknown";

/** Why a connection did not open, as a stage with a hint. Pure — unit-tested. */
export function classifyConnectError(err: unknown): { stage: ConnectStage; code: string; hint: string };

/** The project's own `pg` module, or null when it is not installed there. */
export function loadPg(cwd?: string): unknown | null;

export type ProbeStatus = "ok" | "warn" | "fail";
export type ProbeResult = { name: string; status: ProbeStatus; detail: string; code?: string | null };

/** Anything that speaks node-postgres's `query(text, params) → { rows }` and throws errors carrying a Postgres `code`. */
export interface ProbeClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The probes, against a client. Pure over that client — unit-tested with a stub. */
export function runProbes(client: ProbeClient): Promise<ProbeResult[]>;
