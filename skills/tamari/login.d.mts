// Types for the login skill. The script itself is plain ESM JavaScript so it can
// be run with `node` directly as a skill, without a build step. Only the pure,
// unit-tested helpers are part of the public surface.

export function credentialPath(): string;
export function resolveToken(env: Record<string, string | undefined>, readFile: (path: string, enc: string) => string): string | null;
export const DEFAULT_API: string;

export type Endpoint = {
  /** The origin to talk to. */
  api: string;
  token: string | null;
  /** `env` explicit, `file` from ~/.tamari, `refused` off-host, `none` signed out. */
  source: "env" | "file" | "refused" | "none";
};

/**
 * Where to talk and what credential may go there. The stored credential is
 * bound to the default origin — another host requires TAMARI_TOKEN.
 */
export function resolveEndpoint(
  env: Record<string, string | undefined>,
  readFile: (path: string, enc: string) => string,
): Endpoint;

/** The account last signed in as — a hint, and null when TAMARI_TOKEN is set. */
export function cachedEmail(env: Record<string, string | undefined>, readFile: (path: string, enc: string) => string): string | null;
export function pollOnce(
  fetchImpl: typeof fetch,
  api: string,
  deviceCode: string,
): Promise<{ done: boolean; token?: string; email?: string | null; errorCode?: string; retryAfterMs?: number }>;

/** How long one `--wait` call polls before returning `authorization_pending`. */
export const WAIT_MS: number;

export type PollOutcome =
  | { done: true; token: string; email?: string | null }
  | { done: true; errorCode: string }
  | { done: false; errorCode: "authorization_pending" };

/** Poll until approval, a terminal server answer, or the budget runs out. */
export function pollUntil(
  fetchImpl: typeof fetch,
  api: string,
  deviceCode: string,
  opts: { budgetMs: number; intervalMs: number; now?: () => number; sleep: (ms: number) => Promise<void> },
): Promise<PollOutcome>;
