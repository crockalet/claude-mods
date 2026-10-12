# Claude Code mods

A marketplace of Claude Code mods, one folder each under `plugins/`. Mods need Claude Code 2.1.287 or later.

| Mod | What it does |
| --- | --- |
| [breadcrumbs](plugins/breadcrumbs) | A pane beside the session that Claude talks to you through: the task, notes, questions it went on without, and manual tests that tester subagents walk you through |
| [breadcrumbs-launcher](plugins/breadcrumbs-launcher) | Starts breadcrumbs' testers the moment you press Start, even while Claude is mid-turn |
| [secrets](plugins/secrets) | Hand Claude a secret it can use in Bash commands but never reads |

## Install

```
/plugin marketplace add crockalet/claude-mods
/plugin install breadcrumbs@claude-mods
/plugin install breadcrumbs-launcher@claude-mods
/plugin install secrets@claude-mods
```

Update later with `/plugin marketplace update claude-mods`, then `/plugin update <mod>@claude-mods`.

## What each mod adds

### breadcrumbs

- **Panes:** `breadcrumbs` (task, needs you, your last prompt and Claude's reply, done, notes, decisions and dead ends) and `tests` (manual tests and the steps waiting on you)
- **Commands:** `/whereami` shows or hides the pane (`/whereami clean` tidies old session notes), `/tests` shows or hides the tests pane
- **Tools Claude calls:** `save_note` and `edit_note` for notes it posts on purpose, `test_plan` and `test_update` to plan and revise manual tests
- **Tools testers call:** `await_user` to hand you steps and wait for the answer, `ask_planner` to ask the main agent when a step can't be done
- **Agent:** `breadcrumbs:tester`, one per manual test
- **No tool call needed:** a Haiku side pass after each turn keeps the task current and files explanations as notes; `Open question: …` lines in Claude's replies show up under Needs you, and your answers reach Claude without starting a turn
- **Settings** (`/plugin`): when the pane opens, the side-pass model, the testers' model, and how long session notes are kept and archived

### breadcrumbs-launcher

- No tools or commands. It watches `~/.agents/notes/.launch/<session>/` for breadcrumbs' start requests and spawns `breadcrumbs:tester`, and nothing else. Needs breadcrumbs.

### secrets

- **Tool Claude calls:** `request_secret` with a name and a one-line reason
- **Band above the prompt:** where you enter the value, and approve or deny Bash commands that use it
- **Command:** `/secrets` lists what's set this session (`/secrets forget NAME`, `/secrets clear`)

## Releases

Each mod is released on its own, tagged `<mod>-v<version>` with a GitHub release. The version lives in the mod's `.claude-plugin/plugin.json` and its entry in `.claude-plugin/marketplace.json`; bump both together, since `/plugin update` only picks up a new version.

## Adding a mod

1. Make `plugins/<mod>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.tsx`.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./plugins/<mod>"`.
3. `claude plugin validate plugins/<mod>` and `claude plugin test plugins/<mod>`.
