// Types for the subscribe skill. The script itself is plain ESM JavaScript so it
// can run with `node` directly, without a build step. Only the pure, unit-tested
// helper is part of the public surface.

export type ParsedSubscribeArgs = { plan: "personal" | "pro" } | { error: string };

/** Parse argv (after the script name) into a subscribe command. Pure — unit-tested. */
export function parseSubscribeArgs(argv: string[]): ParsedSubscribeArgs;
