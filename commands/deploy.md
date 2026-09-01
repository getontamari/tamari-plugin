---
description: Build the current project, provision it on Tamari, and return a private HTTPS URL. "/tamari:deploy login" signs you in.
argument-hint: "[login]"
---

# Deploy to Tamari

If `$ARGUMENTS` begins with `login`:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/tamari/login.mjs"`. It prints `{ url, userCode, expiresIn, message }`.
2. **Put the `message` field in your reply, verbatim, as its own paragraph.** It is markdown: the link on its own line, the code, and the three steps. The user does not see tool output — if the link is not in *your* text, they have nothing to click and the sign-in never completes. Do not summarise it, do not bury it under other text.
3. **End your turn here.** Do not run `--wait` in the same turn: approval needs a human with a browser, and they cannot act while you are still working. Wait for them to say they have approved (or to ask you to check).
4. Then run `node "${CLAUDE_PLUGIN_ROOT}/skills/tamari/login.mjs" --wait`. It polls for up to 90 seconds. On `{ ok: true, email }` report the signed-in email and stop. On `{ ok: false, errorCode: "authorization_pending" }` they have not approved yet: show the link again and ask them to approve, then run the same `--wait` command again. On `expired_token` or `access_denied`, start over from step 1.

Otherwise, deploy:
1. Ensure a `tamari.json` exists. If it is missing, use the **tamari** skill to create it (detect the runtime, derive the app id from the directory name).
2. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/tamari/deploy.mjs"`.
3. The script prints NDJSON stage events on stderr — one per **real** stage: `upload`, `build`, `provision` (or `publish` for static), `live`. Render them as a live checklist, one line each, ticking `✓` as each `ok` arrives: the stage label, the event's `detail` if present, and its elapsed `ms` (as seconds) — only fields present on the event. For example:
   ```
   ✓ Uploading source      2.1 MB                1.4s
   ✓ Building image         buildpack · node      38.2s
   ✓ Provisioning           service               9.8s
   ✓ Live
     https://hello-tamari.ontamariusercontent.com
   ```
   Render only the events emitted — never invent a stage or a timing. A `{ "t": "note" }` line is advisory, not a stage: relay its `note` to the user in one line and continue.
4. Read the final stdout JSON:
   - `{ ok: true, url, app }` → present the live result: the URL, that it is **private to the owner**, that it sleeps when idle and wakes on request, and how to reach it (sign in at ontamari.com, tap the launcher icon; on iPhone: Share → Add to Home Screen).
   - `{ ok: false, errorCode, error }` → follow the errorCode table in the **tamari** skill: fix-and-redeploy for the project's own errors; for the "do not modify the project" codes, report and retry — do not loop.
   - `local_database_detected` in particular is **yours to fix, not the user's**: the app stores data in a local SQLite file that a sleeping container wipes. Run `migrate-db.mjs`; port what it cannot rewire to Postgres; set `requiresDatabase: true`; redeploy. Tell the user in one line what you did and why ("moved your data to Tamari's managed Postgres so it survives").
   - `lockfile_platform_mismatch` is likewise **yours to fix**: the committed `package-lock.json` never recorded the Linux natives the builder installs (npm/cli#4828, typical of lockfiles grown on an ARM Mac). Delete `node_modules` (every workspace's too) and `package-lock.json`, run `npm install`, commit the regenerated lockfile, redeploy — and tell the user in one line why ("regenerated your lockfile so it installs on Linux").
