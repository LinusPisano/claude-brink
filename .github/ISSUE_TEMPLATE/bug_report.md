---
name: Bug report
about: Something in Brink doesn't work on your machine
title: ''
labels: bug
assignees: LinusPisano
---

## What happened

<!-- What did you expect, what did you get instead? -->

## `brink doctor` output (required)

<!-- Run `brink doctor` and paste the FULL output below. This is the single most
useful thing you can give — Brink's failure modes are often silent and
environment-dependent, and doctor exercises the whole chain on your machine. -->

```
(paste here)
```

## Environment

- OS + version:
- Node version (`node -v`):
- Claude Code version (`claude --version`):
- Install method: `npm i -g claude-brink` / plugin marketplace / clone
- Custom statusline before installing Brink? yes / no

## If the pause misfired (blocked you when it shouldn't have, or didn't fire)

- Contents of `~/.claude/brink/state.json` at the time (redact `cwd` if you want):

```
(paste here)
```

> Quick escape while we debug: `brink off` disables everything instantly; `brink uninstall` removes Brink and restores your statusline.
