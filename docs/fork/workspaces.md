# Workspaces

A workspace is a separate copy of a repository on its own branch, where you can run many chats
side by side. Each one is a git worktree named after a city, such as `oslo`.

## Create a workspace

Click **+** next to a repository in the sidebar. T3 Code creates the workspace right away: it
fetches the latest default branch from `origin` when the repository has one, creates a worktree
named after a city on a branch that uses your **Settings → Source Control → Worktree branch
naming** prefix (for example `t3/oslo`), and opens its first chat. The setup script's output
streams live in a terminal in the right panel.

The **+** next to **Workspaces** asks which repository to use. To start from a folder or a git URL
you have not added yet, use **Add repository** first.

Starting a new chat in a repository from anywhere else, such as the command palette or a shortcut,
opens it in the workspace you are viewing, or asks you to create one.

## Chats

Open a workspace from the sidebar to see its chats as tabs above the conversation. **+** starts
another chat in the same worktree. Hover a tab and click its **x** to close the chat; the history
button at the right of the tabs reopens closed chats. Right-click a tab to mark it unread, rename
it, close it, or close the others.

While an agent works, its tab and the workspace in the sidebar show a small spinner. A chat with a
reply you have not read shows a blue dot, and its workspace name turns brighter.

Chats without a repository stay in **Chats** at the bottom of the sidebar.

## Workspace scripts

Hover a repository in the sidebar and click its cog, or open **Settings → Projects** and pick the
repository, to reach **Workspace scripts**. Each project has its own.

- **Setup script** runs once when a workspace is created or restored, in a terminal that opens in
  the right panel. Only your script's output shows there.
- **Archive script** runs before a workspace's folder is removed.
- **Scripts** are extra named commands, such as `dev`. Run one from **Run script** in the right
  panel, in its tab bar or on its empty screen. It runs in a terminal in the right panel of the
  chat you're viewing, and the workspace shows its name in blue while it runs. Press `Ctrl+C` in
  the terminal, or close its tab, to stop it.

A repository can also set setup and archive in `t3.json`:

```json
{
  "workspace": {
    "setup": "pnpm install",
    "archive": "docker compose down"
  }
}
```

`t3.json` is read from the workspace's own branch. Without any setup script, the project's setup
action runs, or a `t3.json` script with `"runOnWorktreeCreate": true`. With none of these, nothing
runs and no terminal opens.

Scripts receive `T3_WORKSPACE_NAME`, `T3_WORKSPACE_PATH`, `T3_ROOT_PATH` (the main checkout),
`T3_DEFAULT_BRANCH`, `T3CODE_PROJECT_ROOT`, and `T3CODE_WORKTREE_PATH`. If setup fails, the
workspace shows a warning icon in the sidebar; click it to see the output.

## Archive and restore

Hover a workspace in the sidebar and click its archive button, then confirm.
Archiving runs the archive script, archives the workspace's chats, and removes the folder. The
branch is kept.

Archiving waits for you when:

- an agent is still working in the workspace,
- the folder has uncommitted or untracked files. **Discard and archive** deletes them.
- the archive script fails. **Archive anyway** continues without it.

Archived workspaces are listed under **Archived** in their repository. **Restore** recreates the
folder from the branch, runs setup again, and reopens the chats the archive closed. Chats you
archived yourself stay archived.

## Limits

- The mobile app shows workspace chats in its normal thread list, without tabs.
- Storage cleanup never removes a workspace's folder. Archive the workspace instead.
