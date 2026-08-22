// Types for the redeem skill. The script itself is plain ESM JavaScript so it
// can be run with `node` directly as a skill, without a build step. Only the
// pure, unit-tested helper is part of the public surface.

export type ParsedRedeemArgs = { code: string } | { error: string };

/** Parse argv (after the script name) into a redeem command. Pure — unit-tested. */
export function parseRedeemArgs(argv: string[]): ParsedRedeemArgs;
