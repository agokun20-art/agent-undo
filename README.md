# agent-undo

Undo a coding agent's edits without a Git commit, including files the agent
created or deleted. Each supported agent's prompt hook captures the work you
already have before the agent starts. Inspired by the request to
[bring back Codex's `/undo`](https://github.com/openai/codex/issues/9203).

## Install

Requires Node.js 18+ and Git 2.31+. Install directly from GitHub:

```sh
npm install -g github:agokun20-art/agent-undo
```

Or clone the repository, then pack and install:

```sh
cd agent-undo
npm pack
npm install -g ./agent-undo-0.1.0.tgz
```

`aundo` is an alias for `agent-undo`.

## Quick start

In a Git repository, install the matching project hook and start or restart
your agent. Make sure `agent-undo` is on its `PATH`.

```sh
agent-undo install codex
agent-undo doctor
# Review and trust the hook in Codex with /hooks, then send a prompt.
agent-undo list
agent-undo diff     # Preview what changed since the latest checkpoint
agent-undo undo
agent-undo redo     # Bring the undone edits back
```

You can also run `agent-undo checkpoint -m "before changes"` manually before
using another agent or editing files yourself. No initial Git commit is needed.

## Agent setup

| Install name | Project configuration | Pre-turn event |
| --- | --- | --- |
| [`claude`](https://code.claude.com/docs/en/hooks) | `.claude/settings.json` | `UserPromptSubmit` |
| [`codex`](https://developers.openai.com/codex/hooks) | `.codex/hooks.json` | `UserPromptSubmit` |
| [`cursor`](https://cursor.com/docs/agent/hooks) | `.cursor/hooks.json` | `beforeSubmitPrompt` |
| [`gemini`](https://geminicli.com/docs/hooks/) | `.gemini/settings.json` | `BeforeAgent` |

All four formats were checked against their official documentation. The
Codex hook was also tested end to end using Codex CLI 0.170.0 with a local
model fixture. Use a current agent version with the listed event available.
Follow the agent's project and hook trust prompts; in Codex, review the hook
definition with `/hooks`. Start Gemini CLI from the repository root so it loads
the workspace settings. Use `agent-undo uninstall <agent>` to remove only this
hook. If you run an agent in a container or remote workspace, install the binary
and configure the hook in that environment too.

## Commands

| Command | Behavior |
| --- | --- |
| `checkpoint [-m message]` | Store a working tree snapshot, skipping duplicate trees. |
| `undo [n]` | Rewind `n` distinct working states (default 1). Uses the latest snapshot if the working tree has changed; otherwise steps back from it. |
| `redo` | Restore the working tree saved before the last undo or restore. Refuses to overwrite newer changes. |
| `list` / `log` | List checkpoint IDs on the current timeline, newest first. |
| `diff [id]` | Compare the current working tree with a checkpoint (default: latest). |
| `restore <id>` | Restore a checkpoint from `list`; the pre-restore state is available through `redo`. |
| `install <agent>` / `uninstall <agent>` | Add or remove a project hook without replacing other hooks. |
| `status` / `doctor` | Show the latest checkpoint and redo availability; `doctor` also checks hook configuration. |

## What it saves

Git builds a tree in a temporary index, then records it as a commit under
private, per-worktree refs in `refs/worktree/agent-undo/`. Checkpoints leave
your real index, HEAD, branches, and stash unchanged. Undo changes the working
tree, not what you have staged. Checkpoints include tracked and non-ignored
untracked files; ignored untracked files are left alone. Empty directories
aren't tracked by Git.

Checkpoints aren't isolated by agent session: undo also reverts manual edits
made after the target checkpoint. Run `diff` before undo if you aren't sure
what would change, and wait for the agent to stop writing first. A newly
recorded checkpoint after an undo starts a new timeline and clears redo.
Hook errors are intentionally silent and don't block the agent; use `list`
to confirm a hook ran and `checkpoint` to show any snapshot errors.

Snapshots remain in the local Git object database. They are not part of a
normal branch push, but may contain sensitive files that were not ignored
or are already tracked. Checkpoint history is not automatically pruned in
v0.1. Sparse checkouts, submodules, and embedded Git repositories are not
supported.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to add an agent or run the tests.
Licensed under [MIT](LICENSE).
