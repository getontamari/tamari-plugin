---
description: Start a Tamari session — tell me you're about to build a web app and I'll wire it to deploy as you go.
---

# Start building for Tamari

1. Confirm sign-in **without a network call**: run `test -f "$HOME/.tamari/credentials.json" && echo signed-in || echo signed-out` (or check whether `TAMARI_TOKEN` is set). If signed out, run the sign-in flow from the **tamari** skill yourself: run `login.mjs`, put its `message` in your reply verbatim so the user has the link, and **end your turn** — only run `--wait` after they say they have approved.
2. Set the working agreement, in your own words: they build the app however they like; you will wire it for Tamari as you go — SQLite → the injected `DATABASE_URL`, a `/healthz` route, the trusted `X-Tamari-User-*` identity headers, and a `tamari.json` manifest — so `/tamari:deploy` just works, and the code keeps running locally exactly as before.
3. Do **not** scaffold anything yet. Wait for the user to describe or start building their app, then follow the **tamari** skill's "wire the contract as you build" steps.
