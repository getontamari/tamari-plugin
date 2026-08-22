// Types for the secrets skill. The script itself is plain ESM JavaScript so it
// can be run with `node` directly as a skill, without a build step. Only the
// pure, unit-tested helpers are part of the public surface.

/** Where the plaintext lives. Never the argument list itself. */
export type SecretSource =
  | { kind: "file"; path: string }
  | { kind: "env"; name: string }
  | { kind: "stdin" };

export type ParsedSecretsArgs =
  | { cmd: "list" }
  | { cmd: "set"; key: string; from: SecretSource }
  | { cmd: "unset"; key: string }
  | { error: string };

/** Parse argv (after the script name) into a command. Pure — unit-tested. */
export function parseSecretsArgs(argv: string[]): ParsedSecretsArgs;

export type SecretRead = { value: string; error?: undefined } | { error: string; value?: undefined };

/**
 * Resolve a reference to the plaintext. Pure given its dependencies, and
 * deliberately returns a typed failure rather than throwing — an exception
 * carrying a secret is the sort of thing that ends up in a log.
 */
export function readSecretValue(
  from: SecretSource,
  deps: {
    readFile: (path: string | number, enc: string) => string;
    env: Record<string, string | undefined>;
    readStdin: () => string | null;
  },
): SecretRead;
