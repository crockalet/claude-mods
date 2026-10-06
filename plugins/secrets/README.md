# secrets

A Claude Code mod for handing Claude an API token without pasting it into the chat.

When Claude needs a secret it calls `request_secret` with a name like `GITHUB_TOKEN` and a one-line reason. A field appears above the prompt. You type or paste the value there (ctrl+x tab focuses it, Enter saves it, Cancel declines). Claude only learns that the secret is set. It then writes `$GITHUB_TOKEN` in its Bash commands, and the mod makes the value available to that command.

- The value is written to a 0600 file in a private temp folder and exported only into Bash commands that mention `$NAME` or `${NAME}`. The command Claude sees and the transcript never contain the value.
- Any tool result (subagents' included) or prompt that contains a stored value has it replaced with `«secret:NAME»`.
- Tool calls that name the secrets folder are refused.
- Secrets last for the session. The folder is deleted when the session ends.

Mods need Claude Code 2.1.287 or later.

## Threat model

This stops accidental exposure: a token pasted into a prompt, echoed in a log, printed by a failing `curl -v` or saved in the transcript. It does not stop a model that deliberately tries to get the value out, for example by base64-encoding it, sending it over the network or splitting it across outputs. The field shows what you type as plain text, so mind your screen.

A known value typed or pasted into the main prompt is replaced with `«secret:NAME»` as it lands in the box, and again in every row before the transcript stores it. Still, use the field above the prompt. The prompt box is the fallback, not the way in.

## Known limits

- In auto mode, the permission classifier may deny a subagent's command that uses a secret ("Credential Exploration"), even when the same command runs on the main thread. Run those calls on the main thread, or outside auto mode.
- If a session crashes, the end-of-session cleanup doesn't run and the secrets folder stays in your user-only `$TMPDIR` until the OS clears it.

## Install

```
/plugin marketplace add crockalet/claude-mods
/plugin install secrets@claude-mods
```

## Usage

- Ask Claude for something that needs a token. It calls `request_secret` and the field appears above the prompt.
- `/secrets` lists the names set this session. It never shows values.
- `/secrets forget NAME` removes one, and `/secrets clear` removes all of them.

## Developing

```
claude --plugin-dir plugins/secrets   # hot-reloads on save
claude plugin validate plugins/secrets
claude plugin test plugins/secrets
```
