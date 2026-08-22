// Types for the share skill. The script is plain ESM JavaScript (run directly
// with `node`); only the pure, unit-tested helpers are the public surface.

export type ParsedShareArgs = {
  cmd?: "list" | "invite" | "revoke";
  email?: string;
  role?: "viewer" | "editor";
  error?: string;
};

/** Parse argv (after the script name) into a command. Pure — unit-tested. */
export function parseShareArgs(argv: string[]): ParsedShareArgs;

export type SupersededNotice =
  | { superseded: false }
  | { superseded: true; warning: string };

/** What to say when a re-invite killed the previous link. Pure — unit-tested. */
export function supersededNotice(superseded: boolean | undefined): SupersededNotice;

export type AccessListing = {
  grants?: { userId: string; email: string; role?: string }[];
  invitations?: { id: string; email: string; role?: string }[];
};
export type RevokeTarget = { kind: "grant" | "invitation" | "none"; id: string | null };

/** Resolve an email to the access record to delete. Pure — unit-tested. */
export function resolveRevokeTarget(access: AccessListing, email: string): RevokeTarget;
