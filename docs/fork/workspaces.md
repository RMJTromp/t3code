# Workspaces

A workspace is a separate copy of a repository on its own branch, where you can run many chats
side by side. Each one is a git worktree named after a city, such as `oslo`.

## Create a workspace

Click **+** next to a repository in the sidebar to open the new-workspace composer:

- **What do you want to work on?** becomes the workspace's first message. Leave it empty to
  open an empty chat instead. The footer picks that chat's model, reasoning, and access, like the
  chat composer.
- The message box works like the chat composer: Markdown formats as you type, `@` mentions files
  from the repository, and `$` or `/` insert the chosen agent's skills and commands. Files are
  found in the repository's main folder, since the workspace's folder doesn't exist yet.
- The repository menu at the top left switches repositories.
- The branch next to it is the **target branch**, which the new branch starts from. It defaults
  to the repository's default branch. **Start from remote** in its menu uses origin's latest copy.
- The branch icon at the top right checks out something that already exists instead. Pick a
  branch, or an open pull request from **Pull requests**. A branch that is already checked out in
  another folder can't be picked. Your choice replaces the icon; click it to change it, or hover
  it and click the **x** to go back to a new branch.
- **Issues** in the same menu appends an open issue to your message as a fenced Markdown block
  (a linked heading, then its body), with the cursor placed below it. You can edit it before
  sending. Removing the issue removes that
  text, unless you changed it.
- Pull requests and issues come from the GitHub CLI on the machine running T3 Code, so install
  `gh` and run `gh auth login` there. Without it, pull requests come from **Settings → Source
  Control** instead, and issues are unavailable. All three lists load as soon as the composer
  opens.

T3 Code then creates the workspace: a worktree named after a city, on a new branch that uses your
**Settings → Source Control → Worktree branch naming** prefix (for example `t3/oslo`), or on the
branch or pull request you picked. It opens the first chat right away, and the setup script's
output streams live in a terminal in the right panel. Your message is sent once setup finishes. If
setup fails, it stays in the composer for you to send yourself.

Hold **⌘** (macOS) or **Ctrl** while clicking **+** to skip the composer and create a workspace
on a new branch from the default branch at once.

The **+** next to **Workspaces** opens the same composer for the repository you are viewing. To start from a folder or a git URL
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
  panel's **+** menu or on its empty screen. It runs in a terminal in the right panel of the
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

## Archive a workspace

Hover a workspace in the sidebar and click its archive button. Archiving runs the archive script in
the background, archives the workspace's chats, and removes the folder. The branch is kept, and the
workspace leaves the sidebar.

Archiving stops and tells you when:

- an agent is still working in the workspace,
- the folder has uncommitted or untracked files. **Discard and archive** deletes them.
- the archive script fails. **Show output** opens its output, where **Archive anyway** continues
  without it.

## Limits

- The mobile app shows workspace chats in its normal thread list, without tabs.
- Storage cleanup never removes a workspace's folder. Archive the workspace instead.
