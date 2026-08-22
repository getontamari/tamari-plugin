// Git state checks shared by the two scripts that rewrite a project's files
// in place.
//
// A library, not a command: no main guard, nothing to run.
//
// SKILL.md promises the user that "every change is reversible with git". That
// is only true for a file git already has a copy of. `migrate-db.mjs` and
// `optimize-startup.mjs` rewrite next.config.*, settings.py, requirements.txt
// and schema.prisma in place — so uncommitted edits to those files, or an
// untracked file of the same name, are destroyed with no way back. Not a
// vulnerability; just the one promise the docs make that the code did not keep.

import { execFileSync } from "node:child_process";

/**
 * Which of `paths` git could not restore. Pure — unit-tested.
 *
 * Takes the output of `git status --porcelain -z`. NUL-separated rather than
 * newline-separated because git quotes and escapes paths in the newline form,
 * and a quoted path never matches the plain one we are looking for. (Same class
 * of mistake as splitting `git ls-files` on newlines — see deploy.mjs.)
 *
 * A path git reports *nothing* for is safe: either it is committed and
 * unmodified, so a rewrite is revertible, or it does not exist yet, so there is
 * nothing to lose. Everything else — modified, staged, or untracked — counts.
 * Untracked matters as much as modified: git has no copy of it either way.
 */
export function dirtyTargets(porcelainZ, paths) {
  const wanted = new Set(paths);
  const dirty = new Set();
  for (const entry of porcelainZ.split("\0")) {
    // "XY path": two status characters then a space. A rename's second entry is
    // a bare path with no prefix, which this skips — it would have to be a file
    // whose third character is a space to be mistaken for a status line, and
    // the cost of that miss is a refusal, which is the safe direction.
    if (entry.length < 4 || entry[2] !== " ") continue;
    const path = entry.slice(3);
    if (wanted.has(path)) dirty.add(path);
  }
  return [...dirty];
}

/** Ask git about exactly these paths. Returns the subset it could not restore. */
export function uncommittedAmong(paths, run = defaultRun) {
  if (paths.length === 0) return [];
  try {
    return dirtyTargets(run(paths), paths);
  } catch {
    // Not a repository, or git is unavailable. The caller decides what that
    // means; this function does not get to claim the tree is clean.
    return null;
  }
}

function defaultRun(paths) {
  return execFileSync("git", ["status", "--porcelain", "-z", "--", ...paths], { encoding: "utf8" });
}

/**
 * The message both scripts give when they refuse. Pure — unit-tested.
 *
 * Names the files rather than saying "your tree is dirty", because the user
 * almost certainly has other unrelated edits in progress and telling them to
 * commit everything would be wrong advice.
 */
export function uncommittedWarning(paths) {
  const list = paths.join(", ");
  return {
    warning:
      `Not rewriting ${list}: ${paths.length === 1 ? "it has" : "they have"} changes git has no copy of, ` +
      `so this edit could not be undone. Other uncommitted work is fine — only these files matter.`,
    nextSteps: [
      `Commit or stash just these files: git add ${list} && git commit -m "wip"`,
      "Then run this again — the rewrite is revertible once git has a copy.",
    ],
  };
}
