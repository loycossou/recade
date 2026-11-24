---
description: End this session cleanly. Push what the workspace holds and has not pushed yet, then stop the session, also where the built-in exit only detaches it (Remote Control, the app).
allowed-tools: Bash(node:*), Bash(npm ci:*), Read
---

<!-- shared:cli-harness -->In this file, `recade <sub>` means `node "$RECADE_PLUGIN_ROOT/bin/recade.js" <sub>`.<!-- /shared:cli-harness --> Run it exactly that way, from the workspace folder. <!-- shared:plugin-root-file -->When Step 0 reads the plugin folder from `.recade/plugin-root`, write that folder in place of `$RECADE_PLUGIN_ROOT` in every command line.<!-- /shared:plugin-root-file -->

Write short, plain sentences. No exclamation marks, no emoji, no long dash.

The user may give arguments after the command: `$ARGUMENTS`. None are expected: say so in one line if the owner typed something, and go on.

## Step 0. Plugin root and dependencies

<!-- shared:harness-plugin-root -->
1. Run `node -p "process.env.RECADE_PLUGIN_ROOT || ''"`. If it prints a folder, that folder is the plugin root.
2. If it prints nothing, read `.recade/plugin-root` with Read, in the current folder or in the folders above it. The session starts at the root of the workspace, which holds one. A worktree of a slice under `worktrees/` has no copy of its own, and the workspace around it does, so the search finds it on the way up. If the file exists, its first line is the plugin root.
3. If both are missing, say "The Recade plugin folder is not known here. Set RECADE_PLUGIN_ROOT, or run /recade:harness again in this project." and stop.
4. Check with Read that `<plugin root>/harness/hooks/guard.mjs` exists. If it does not, the folder is stale (the plugin moved or was updated) and the guard of the project refuses every write and every shell command: say "The Recade plugin folder <plugin root> has no guard. Run /recade:harness again in this project." and stop.
5. Run `node "$RECADE_PLUGIN_ROOT/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "$RECADE_PLUGIN_ROOT"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.
<!-- /shared:harness-plugin-root -->

## Step 1. Push

Run `recade workspace push`. It pushes the commits of the workspace that are not on its remote yet, when the owner turned the automatic push on. Show its line. A failed push is shown and does not stop the exit: the next session pushes what is left.

## Step 2. Stop the session

1. Say, in one line and in the language of the conversation, that the session ends now.
2. Run `recade session end`. It stops this session a moment after it returns. Run nothing after it.
