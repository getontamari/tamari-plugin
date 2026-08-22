---
description: Manage encrypted app secrets (API keys, tokens) injected as environment variables at deploy time.
argument-hint: "set KEY=value | list | unset KEY"
---

# App secrets

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/tamari/secrets.mjs" $ARGUMENTS` from the app's directory (it reads the app id from `tamari.json`).

- `set KEY --from-file <path>` — store an encrypted secret, read from a file so the value never appears in a command. Also `--from-env <VAR>` for CI, or `--stdin` to pipe it. Keys are `A–Z`, digits and `_`; `DATABASE_URL`, `PORT` and `K_*` are reserved.

  `set KEY=value` is **refused**: a secret in an argument is visible to every process on the machine, lands in shell history, and is captured in the agent transcript. Put the value in a file and pass the path.
- `list` — names only (never values).
- `unset KEY` — remove one.

Secrets **never** go in `tamari.json` (it is committed). A secret change takes effect on the next `/tamari:deploy` — offer to redeploy.

## Static apps cannot hold secrets

`set` on a static app fails with `static_app_has_no_runtime`. A static site is files on a CDN with no server, so nothing would ever read the value. Two ways forward, and which one is right depends on the key:

- **It must stay private** (a Stripe secret key, a database password) → the app needs a runtime. Set `runtime` in `tamari.json`, **deploy first** (the runtime is promoted at go-live), then set the secret and redeploy.
- **The browser has to send it** (a Maps key, a publishable key) → on a static site it is public whatever you do. Use the provider's *publishable* key and restrict it by domain in their dashboard.

Do **not** work around the refusal by putting the key in the page. On a static app that publishes it to every viewer, including everyone the app is shared with.

`list` marks `inert: true` if an app that used to have a runtime was converted to static — its stored secrets are unreadable by anything, and `unset` still removes them.
