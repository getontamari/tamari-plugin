// Types for the delete skill. The script is plain ESM JavaScript (run directly
// with `node`); only the pure, unit-tested helpers are the public surface.

export type ParsedDeleteArgs = {
  cmd?: "delete";
  appId?: string;
  error?: string;
};

/**
 * Parse argv into a command. Pure — unit-tested.
 *
 * The app id is required and must match tamari.json when one is present:
 * deletion is irreversible and retires the id, so "the app in this directory"
 * is too easy to get wrong.
 */
export function parseDeleteArgs(argv: string[], manifestAppId: string | null): ParsedDeleteArgs;

/** Turn an API failure into an actionable errorCode and message. Pure. */
export function describeFailure(
  status: number,
  body: { error?: string; failed?: string[] },
): { code: string; message: string };
