# breadcrumbs-launcher

Lets [breadcrumbs](../breadcrumbs) start a manual-test tester the moment you press **Start tester**, even while Claude is mid-turn.

A Claude Code mod can't answer tool calls from an agent it spawned itself: that agent skips every hook of the mod that spawned it. So breadcrumbs used to ask the main agent to spawn each tester, and you waited until Claude was free. This mod does the spawning instead. Breadcrumbs leaves a request under `~/.agents/notes/.launch/<session>/`, this mod picks it up within a second, and breadcrumbs answers the tester's tools as usual. The tester's final report still goes to the main session.

It starts only `breadcrumbs:tester`, and nothing else. Breadcrumbs falls back to asking Claude if this mod isn't running.

## Install

```
/plugin install breadcrumbs-launcher@claude-mods
```
