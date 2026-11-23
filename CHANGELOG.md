# Changelog

## Unreleased

- Retain the newest 100 checkpoints by default, with a configurable limit and
  a manual `undoturn prune --dry-run` preview that preserves pending redo steps.

## 0.1.0

- Save working-tree snapshots, including untracked files, without changing the
  Git index, HEAD, branches, or stash.
- Undo, redo, list, diff, and restore checkpoints with the `undoturn` command.
- Install or remove pre-turn hooks for Claude Code, Codex, Cursor, and Gemini CLI.
