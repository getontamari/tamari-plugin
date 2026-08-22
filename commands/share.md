---
description: Share an app by email (viewer or editor), revoke access, or list who can reach it.
argument-hint: "invite <email> [viewer|editor] | revoke <email> | list"
---

# Share a Tamari app

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/tamari/share.mjs" $ARGUMENTS` from the app's directory (it reads the app id from `tamari.json`).

- `invite <email> [viewer|editor]` (default `editor`) → confirm who was invited and their role. Note they get a link at ontamari.com/invite, and access is granted only if their identity provider has **verified** that email — an invite can't be claimed by someone who merely types the address. There is no public "anyone with the link" mode.
  - If the response has `superseded: true`, **lead with the `warning`**: this address already had a pending invitation, that one is now revoked, and any link already sent to them has stopped working. The recipient isn't told — nothing emails invitations — so the user has to send the new link themselves.
- `revoke <email>` → confirm removal. Note that a session already open is cut off within ~10 seconds, and the change is recorded in the audit trail.
- `list` → show current grants and pending invitations.

On `{ ok: false, errorCode }`: `not_signed_in` → have them run `/tamari:deploy login`; `not_found` → the email has no access or pending invite; otherwise report the message.
