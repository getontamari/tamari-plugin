---
description: Delete a Tamari app and everything it provisioned. Irreversible — the app id is retired.
argument-hint: "<app-id>"
---

# Delete a Tamari app

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/tamari/delete.mjs" $ARGUMENTS` from the app's directory.

**Confirm with the user before running this.** It removes the app's running service or published files, its database and secrets, and everyone's access. It cannot be undone, and the app id is **retired** — the hostname can never be deployed to again, by them or anyone else. Say all of that, and wait for a clear yes.

The app id is a required argument and must match `tamari.json`; there is no flag that skips it.

On `{ ok: true }`: confirm what was removed, and that the id is retired.

On `{ ok: false, errorCode }`:

| `errorCode` | What to do |
|---|---|
| `invalid_request` | The id is missing or does not match `tamari.json` — show the message |
| `not_signed_in` | Run `/tamari:deploy login` |
| `app_not_found` | No such app, or not theirs. **Do not** guess other ids — the API will not confirm one they do not own |
| `delete_incomplete` | Some resources survived; the app still counts against their quota. Safe to run again, and running again is the fix |
| `server_error` | Report and retry later; do not modify the project |
