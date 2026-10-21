# Fork layer

This fork adds features on top of upstream T3 Code without rewriting upstream code, so
merging upstream stays a routine pull.

## The rule

- Fork logic lives in `fork/` folders: `packages/contracts/src/fork/`, `apps/server/src/fork/`,
  `apps/web/src/fork/`, and `docs/fork/`.
- Upstream files only gain imports, one spread per registration list, component mounts, and
  one-line delegations. Every such line carries its feature's tag, such as `// fork:workspaces`
  (or `{/* fork:workspaces */}` in JSX), so `git grep -E "fork:[a-z-]+"` lists every touch point.
- Spreads go at the top of upstream lists, because upstream appends to the end.
- Keep fork RPCs to the three that exist (one command, two streams). Upstream's RPC group sits near
  a TypeScript complexity limit; a new fork RPC can tip the server build into `any` errors. Add a
  `type` to `WorkspaceCommand` instead.
- Fork tables use their own migration ledger (`fork_schema_migrations`), never upstream's numbered
  `Migrations/NNN_*` files.
- Server guards read `WorkspaceOwnership`, a `Context.Reference` with an empty default, so upstream
  layers and tests run unchanged without the fork layer.
- Upstream web hooks import `apps/web/src/fork/workspaces/registry.ts`, not `state.ts`, so their
  module graphs and test mocks never pull in the connection runtime.

Deleting the tagged lines and the `fork/` folders restores upstream behavior.

## Features

Every fork feature, where a user reaches it, and the commit that introduced it. After an upstream
merge, walk this list to confirm each one is still reachable.

| Feature                    | How to reach it                                                                                                                                                                                                                                                                                    | Commits                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Workspace sidebar          | Replaces upstream's sidebar: Workspaces by repository, sorted by their latest turn start or end (archived and deleted chats still count), with compact times, spinner and unread state, then Chats.                                                                                                | `e5d7f528c`, `3f91f1b27` |
| Create a workspace         | **+** on a repository row opens a composer: prompt, model, target branch, a branch or PR to check out, or an issue (`gh`) to attach. With **Plan mode (legacy)** on, Build/Plan, `/plan`, `/default`, and Shift+Tab pick the first chat's mode. ⌘/Ctrl-click creates at once.                      | `e5d7f528c`, `7167058b4` |
| Tag PRs and issues         | `#` in the chat composer or the new-workspace composer lists open PRs and issues from `gh`; upstream lookup without it.                                                                                                                                                                            | —                        |
| Chat tabs                  | Tabs under a workspace chat's header, in the order they opened: **+**, close, history to reopen, right-click to mark unread, rename, close others. **+** always opens a new draft; unsent drafts keep an Untitled tab, with an orange dot once they hold text. Closing one discards it, with undo. | `e5d7f528c`              |
| New chats join a workspace | New chat from the command palette or a shortcut opens in the workspace in view, or asks to create one. Each workspace keeps its draft.                                                                                                                                                             | `e5d7f528c`              |
| Locked checkout            | Chats in a workspace cannot switch to another checkout in the branch toolbar.                                                                                                                                                                                                                      | `e5d7f528c`              |
| Archive a workspace        | Archive button on a workspace row. One click; script, uncommitted-file, and running-agent failures arrive as toasts.                                                                                                                                                                               | `e5d7f528c`, `06b1132ca` |
| Workspace scripts          | Cog on a repository row, or **Settings → Projects**: setup, archive, and named scripts. Settings win over `t3.json`.                                                                                                                                                                               | `3f91f1b27`              |
| Run script                 | Right panel's **+** menu and empty screen. Runs a named script in a terminal; the workspace row shows its name while it runs.                                                                                                                                                                      | `3f91f1b27`, `fee04f460` |
| Setup failure output       | Warning icon on a workspace row whose setup failed; opens the output with retry.                                                                                                                                                                                                                   | `e5d7f528c`              |
| Server guards              | Setup runs once per workspace, storage cleanup keeps workspace worktrees, and only archive may remove one.                                                                                                                                                                                         | `e5d7f528c`              |
| Diff pane defaults         | Opening the diff pane, by any route, shows **Uncommitted** with every file collapsed, including files that appear later. A turn's diff link still opens that turn. Tag: `fork:diff-defaults`.                                                                                                      | —                        |

Restore is implemented on the server (`unarchive`), but since `06b1132ca` the sidebar no longer
lists archived workspaces, so no client reaches it.

## Touch points

| File                                                                                   | Why                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/contracts/src/{index,rpc,clientRpcPermissions}.ts`                           | Export and register the workspace RPCs and client scopes.                               |
| `packages/client-runtime/src/rpc/client.ts`                                            | Let clients subscribe to the two workspace streams.                                     |
| `apps/server/src/server.ts`, `ws.ts`, `ws.test.ts`                                     | Provide the workspace layer and its RPC handlers.                                       |
| `apps/server/src/auth/RpcAuthorization.ts`, `observability/RpcInstrumentation.ts`      | Scopes and metrics tags for the new RPCs.                                               |
| `apps/server/src/project/ProjectSetupScriptRunner.ts`                                  | A workspace runs its setup once; new chats in it skip the project's setup action.       |
| `apps/server/src/git/GitWorkflowService.ts`                                            | Refuse to remove a live workspace's worktree from anywhere but its own archive.         |
| `apps/server/src/storageCleanup.ts`                                                    | Cleanup policies keep workspace worktrees.                                              |
| `apps/web/src/components/AppSidebarLayout.tsx`                                         | Mount the workspace sidebar and dialogs.                                                |
| `apps/web/src/components/ChatView.tsx`                                                 | Mount the chat tabs; send the new-workspace composer's prompt once the worktree exists. |
| `apps/web/src/components/chat/ChatComposer.tsx`, `ComposerCommandMenu.tsx`             | `#` suggestions come from `gh` when it works; issues are a fork menu item.              |
| `apps/web/src/components/composerContextPresentation.tsx`, `chat/MessagesTimeline.tsx` | Issue references render as the same issue chip in the composer and in sent messages.    |
| `apps/web/src/hooks/useHandleNewThread.ts`                                             | Route new project chats into a workspace and give each workspace its own draft.         |
| `apps/web/src/hooks/useThreadActions.ts`                                               | Deleting a workspace's last chat never offers to delete its worktree.                   |
| `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`                             | Chats in a workspace cannot switch to another checkout.                                 |
| `apps/web/src/components/settings/ProjectSettingsPanel.tsx`                            | Mount the Workspace scripts section on a project's settings page.                       |
| `apps/web/src/components/RightPanelTabs.tsx`                                           | Mount the Run script menu in the right panel's "+" menu and empty screen.               |
| `apps/web/src/components/{ChatView,DiffPanel}.tsx`, `hooks/useProactivePanels.ts`      | Open the diff pane on uncommitted changes and reset its folds (`fork:diff-defaults`).   |

## Merging upstream

1. `git fetch upstream && git merge upstream/main`.
2. Conflicts can only touch the lines above. Re-apply each tagged line where the surrounding code
   moved.
3. Run the fork tests: `vp test run apps/server/src/fork apps/web/src/fork`, then typecheck the
   server and web packages.

To use upstream's sidebar instead, set `t3fork:use-upstream-sidebar` in the browser's localStorage.
That also turns off routing new chats into workspaces.
