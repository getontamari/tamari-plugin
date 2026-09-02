// Types for the logs skill. The script is plain ESM JavaScript (run directly
// with `node`); only the pure, unit-tested helpers are the public surface.

export type Severity = "DEFAULT" | "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" | "ALERT" | "EMERGENCY";

/** Cloud logging severities, in rank order. Plain stdout/stderr text is DEFAULT. */
export const SEVERITY_RANK: Record<Severity, number>;

/** The most entries the platform returns per call. */
export const SERVER_CAP: number;

export type LogsOptions = {
  lines: number;
  since: string | null;
  grep: string | null;
  severity: Severity | null;
  app: string | null;
};

/** Parse argv (after the script name). Pure — unit-tested. */
export function parseLogsArgs(argv: string[]): LogsOptions | { error: string };

/** `--since` as an epoch millisecond, or null when it cannot be read. Pure — unit-tested. */
export function sinceFrom(spec: string, now?: number): number | null;

/** A log line made safe to display, with NUL bytes kept visible as `\0`. Pure — unit-tested. */
export function sanitizeLogText(text: unknown, max?: number): string;

export type LogEntry = { timestamp: string; severity: string; text: string };

/** The entries to show: oldest first, filtered, then the last `lines`. Pure — unit-tested. */
export function selectEntries(
  entries: LogEntry[] | null | undefined,
  opts?: { lines?: number; sinceMs?: number | null; grep?: string | null; severity?: Severity | null },
): LogEntry[];

/** What the reader has to know about the lines they are not seeing. Pure — unit-tested. */
export function logNotes(input: {
  returned: number;
  shown: number;
  entries: LogEntry[];
  windowHours?: number | null;
  opts?: Partial<LogsOptions>;
}): string[];
