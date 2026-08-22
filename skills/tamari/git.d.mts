// Types for the git-state helpers. Plain ESM JavaScript so the skill runs with
// `node` and no build step; only the pure, unit-tested helpers are public.

/**
 * Which of `paths` git could not restore. Pure — unit-tested.
 *
 * Takes the output of `git status --porcelain -z`. A path git reports nothing
 * for is safe: either committed and unmodified, or not yet existing.
 */
export function dirtyTargets(porcelainZ: string, paths: string[]): string[];

/**
 * Ask git about exactly these paths.
 *
 * Returns the subset it could not restore, or **null** when git cannot answer
 * at all — outside a repository, or with git unavailable. Null rather than an
 * empty array on purpose: "no dirty files" and "no idea" must not look alike to
 * a caller about to overwrite someone's work.
 */
export function uncommittedAmong(
  paths: string[],
  run?: (paths: string[]) => string,
): string[] | null;

/** The refusal message, naming the files rather than the whole tree. Pure. */
export function uncommittedWarning(paths: string[]): {
  warning: string;
  nextSteps: string[];
};
