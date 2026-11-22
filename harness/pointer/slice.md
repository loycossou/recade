---
description: This is a code repository of a Recade workspace. Slices are delivered from a session started at the root of the workspace, and this command says where it is.
allowed-tools: Bash(node:*), Read
---

<!-- shared:cli-harness -->In this file, `recade <sub>` means `node "$RECADE_PLUGIN_ROOT/bin/recade.js" <sub>`.<!-- /shared:cli-harness --> <!-- shared:plugin-root-file -->When Step 0 reads the plugin folder from `.recade/plugin-root`, write that folder in place of `$RECADE_PLUGIN_ROOT` in every command line.<!-- /shared:plugin-root-file -->

Write short, plain sentences. No exclamation marks, no emoji, no long dash.

<!-- recade-pointer -->

This folder is a code repository of a Recade workspace. The harness lives at the root of the workspace: every command and every agent is there, and so is `/slice`. This command does nothing else than say where to go. It writes no file and runs no agent.

## Step 0. Plugin root

1. Run `node -p "process.env.RECADE_PLUGIN_ROOT || ''"`. If it prints a folder, that folder is the plugin root.
2. If it prints nothing, read `.recade/plugin-root` with Read, in this repository. If the file exists, its first line is the plugin root. If it does not, skip Step 1 and say the text of Step 2 without the folder.

## Step 1. The workspace

Run `recade workspace root`. It prints the folder of the workspace: call it `<home>`. If it exits 1, show its message, which names `recade repo sync`, and stop.

## Step 2. Where to work

Tell the owner, in a few lines:

1. Slices are delivered from the workspace, not from a code repository: start a new Claude Code session at `<home>`, the root of the workspace, and type `/slice <S-nn>` there.
2. `/slice` reads the `touches:` of the sheet and opens the worktree of each code repository it names itself, under `<home>/worktrees/<repo>/<S-nn>`. There is no folder to choose.
3. `/status` in that session shows the slices that can start now.

Then stop. Do not run `/slice` here, and do not open a worktree yourself.
