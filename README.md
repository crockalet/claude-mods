# Claude Code mods

A marketplace of Claude Code mods, one folder each under `plugins/`. Mods need Claude Code 2.1.287 or later.

- [breadcrumbs](plugins/breadcrumbs): a pane with what the session is about, your notes and manual tests

## Install

```
/plugin marketplace add crockalet/claude-mods
/plugin install breadcrumbs@claude-mods
```

## Adding a mod

1. Make `plugins/<mod>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.tsx`.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./plugins/<mod>"`.
3. `claude plugin validate plugins/<mod>` and `claude plugin test plugins/<mod>`.
