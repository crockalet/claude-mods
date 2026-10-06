# breadcrumbs

A Claude Code mod that keeps a pane beside the session with what it's about, so you can switch worktrees and pick up where you left off.

- **Task**: the session's goal, kept current by a cheap side pass after each turn
- **Needs you**: questions and decisions Claude left for you, and any question it's waiting on now
- **You asked / Claude**: your last prompt, what Claude is running and the start of its last reply
- **Notes**: explanations and summaries you asked for, saved as Markdown and previewable in the pane (Pin keeps one for good)
- **Decided / Tried**: choices Claude made on its own, and approaches it tried (✗ marks a dead end)

Mods need Claude Code 2.1.287 or later.

## Install

```
/plugin marketplace add crockalet/breadcrumbs
/plugin install breadcrumbs@breadcrumbs
```

`/whereami` shows or hides the pane. It opens by itself at 144+ columns.

## Manual tests

When you need to run tests by hand, Claude lists them in a second pane (`/tests`) with their steps. **Start tester** hands one test to a tester subagent that walks you through it, follows the logs while you go, and sends its final report to the main session, so the main agent stays the orchestrator.

- Claude plans like a planner: a shared brief every tester trusts, tests grouped by physical setup, and the remaining tests revised (or marked blocked) after each report.
- A tester hands you a run of steps at once and stops only at checkpoints. Its questions come with their own answer buttons; plain steps get Done / Can't. You can always type a reply, and the status line counts what's waiting.
- Feedback typed on a test goes to the step it's waiting on, else its running tester, else Claude.
- A bare Pass costs no turn; it rides along with your next prompt.

## Files

Notes live outside your repos, one folder per session:

```
~/.agents/notes/<repo>/<worktree>/
  index.md                        one line per session
  <date>-<task>-<id>/
    context.md                    the pane as a file
    NN-<title>.md                 notes
    state.json                    restores the pane on resume
~/.agents/notes/<repo>/_pinned/   pinned notes
```

Session folders are archived after 30 days, or as soon as their worktree is gone, and deleted 60 days after that. `/whereami clean` shows what would go and asks first. Both periods, the side-pass model and when the pane opens are settings in `/plugin`.

## Developing

```
claude --plugin-dir ~/repos/plugins/breadcrumbs   # hot-reloads on save
claude plugin validate .
claude plugin test .
```
