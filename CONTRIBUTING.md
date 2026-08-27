# Contributing to the Tamari plugin

Everything in this directory is **readable by everyone who installs the plugin**.
There is no compilation step and no minification — the `.mjs` files ship as
source, comments included. Two rules follow from that, and both have been
learned rather than assumed.

## What ships

> **Ship what an agent needs to build, deploy and fix an app. Do not ship
> descriptions of how the platform is built internally, unless the agent's
> behaviour depends on it.**

The second clause does most of the work, because a surprising amount of
apparently-internal detail is load-bearing:

| Ships | Because |
|---|---|
| `X-Tamari-User-*` header names | A customer's own app reads them. Documenting them tells a reader what to forge — and the defence is that the gateway overwrites them unconditionally, not that they are secret. `test/abuse-controls.test.ts` proves a forged `x-tamari-user-id` arrives as the real user, which makes that test load-bearing for a publicly documented attack |
| Postgres, by name, throughout `migrate-db.mjs` | The script's entire job is rewriting a project's code to talk to it. It cannot be described without naming it |
| `verify it binds process.env.PORT` | How an agent fixes a real class of startup failure |
| Every error code | They encode retry-vs-do-not-retry. Collapsing them is the bug described below |
| Security hazards, explained plainly | A fork that does not know *why* `--null -T -` is there will helpfully simplify it back into a command-injection vulnerability |

| Does not ship | Because |
|---|---|
| Paths into the private repository | A citation nobody can follow, that names a file they cannot read |
| Named cloud products where the conclusion is what matters | "A static site is cheaper and has no cold start" is actionable; which storage product serves it is not |
| Internal vocabulary for user-facing guarantees | "Revocation takes effect within ~10s" is a promise; "the access epoch is bumped at the gateway" is an implementation |
| Issue numbers and internal spec references | They point at a tracker the reader cannot see — and once this lives in its own repository, they point at the *wrong* issues |

Hiding the cloud provider is not a security control: the TLS certificates and
response headers give it away in seconds. Whether to advertise it is a
positioning question, answered here as "only where it helps the reader".

## Vagueness is not discretion

**Do not make an error message vaguer to reveal less.** An agent that cannot
tell "your app crashed" from "our platform is misconfigured" edits code that was
never broken and loops on something it cannot fix. That was a real bug, and the
error codes exist because of it.

Clarity to the agent and discretion about internals are almost always
compatible. Where a specific case genuinely forces a choice, **clarity wins**,
and the case gets written down rather than quietly resolved.

## Bump `version` on every change

Keep `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` on the same
version. The version is the cache key for installed copies. Ship a change
without bumping it and an install can serve stale code — nobody gets the
update, including security fixes, and nothing reports an error.

`version` lives in each host's `plugin.json` **only**. The marketplace manifest
must not set it: a stale value there silently masks the real one.
