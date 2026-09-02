# Tamari for Claude Code and Codex

Deploy the project you are working on to a private HTTPS URL you open on your
phone. One command, no containers, no DNS, no cloud console.

### Claude Code

```text
/plugin marketplace add getontamari/tamari-plugin
/plugin install tamari@tamari
```

### Codex

```sh
codex plugin marketplace add getontamari/tamari-plugin
codex plugin add tamari@tamari
```

Start a new Codex conversation after installation so the Tamari skill is
available from the beginning of the session.

Then, in any project, just say what you want:

> deploy this

## What it does

- **Deploys** the current directory and gives you a URL. Node, Python, Go, or a
  static site — detected from the files already in your project.
- **Private by default.** Nobody can open your app until you share it, and
  sharing requires the recipient's identity provider to have *verified* that
  email address.
- **Wires the boring parts as you build.** A local SQLite file is wiped on every
  cold start, so it offers to move you to the managed Postgres it injects. A
  Next.js app that can export statically gets a zero cold start.
- **Holds your secrets** encrypted, injected as environment variables at deploy
  time, never in the committed manifest.
- **Reads the container log from the terminal**, so the agent diagnoses a
  broken deploy itself instead of asking you to paste lines from a dashboard —
  and checks the app's health path after every deploy, because "the port
  opened" and "the app works" are different facts.

Plain-language requests work in both hosts. Claude Code also exposes these
optional slash commands: `/tamari:deploy`, `/tamari:status`, `/tamari:share`,
`/tamari:secrets`, `/tamari:logs`, `/tamari:delete`, `/tamari:start`. Codex
invokes the same workflows through the Tamari skill rather than those aliases.

## What it needs

Claude Code or Codex, plus `git` and `node`. Your project must be a git
repository — only tracked files are uploaded, which is what keeps
`node_modules` and a stray `.env` out of the build.

## Where the code runs

This repository is the client. It talks to Tamari over HTTPS and holds no
credentials of its own beyond the token the device sign-in writes to
`~/.tamari/credentials.json`, owner-readable only.

The scripts ship as readable source on purpose. If you are changing them, read
[CONTRIBUTING.md](CONTRIBUTING.md) first — particularly the note about bumping
`version`, without which nobody receives your change.

## Security

Found something? Email security@ontamari.com rather than opening a public issue.

## Licence

MIT.
