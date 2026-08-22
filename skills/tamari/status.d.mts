// Types for the status skill. The script is plain ESM JavaScript (run directly
// with `node`); only the pure, unit-tested helpers are the public surface.

export type AccountUsage = {
  apps: number;
  appLimit: number;
  alwaysOn: number;
  alwaysOnSlots: number;
};

/** The `/api/me` payload, as far as this script reads it. */
export type AccountPayload = {
  user: { id: string; email: string; displayName: string | null };
  plan: {
    key: "free" | "personal" | "pro";
    appLimit: number;
    alwaysOnSlots: number;
    status: string | null;
  };
  usage: AccountUsage;
  entitled: boolean;
  /** Days of disuse after which a token stops working. */
  idleDays?: number;
  credentials?: AccountCredential[];
  apps: { id: string; name: string; runtime: string; state: string; url: string }[];
  sharedWithMe?: {
    id: string;
    name: string;
    runtime: string;
    state: string;
    role: string;
    ownerEmail: string;
    url: string;
  }[];
};

/** A deploy token and how long it has left before idling out. */
export type AccountCredential = {
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  daysLeft: number;
  /** True for the credential making this request — never near expiry. */
  current: boolean;
};

export type AccountSummary = {
  ok: true;
  account: string;
  plan: string;
  planStatus: string | null;
  quota: string;
  atLimit: boolean;
  entitled: boolean;
  /** Null unless the plan has always-on slots at all. */
  alwaysOn: string | null;
  credentials: AccountCredential[];
  apps: { id: string; name: string; runtime: string; state: string; url: string }[];
  sharedWithMe: NonNullable<AccountPayload["sharedWithMe"]>;
  notes: string[];
};

/**
 * Make a server-provided string safe to display: control characters and line
 * breaks flattened, length bounded. Some of this output is written by other
 * tenants. Pure — unit-tested.
 */
export function displayText(value: unknown, max?: number): string;

/** "3 of 10 apps". Pure — unit-tested. */
export function quotaLine(usage: Pick<AccountUsage, "apps" | "appLimit">): string;

/** Shape `/api/me` into what the agent should say. Pure — unit-tested. */
export function summarizeAccount(payload: AccountPayload): AccountSummary;
