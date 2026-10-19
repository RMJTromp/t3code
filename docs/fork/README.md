# Fork layer

This fork adds features on top of upstream T3 Code without rewriting upstream code, so
merging upstream stays a routine pull.

## The rule

- Fork logic lives in `fork/` folders: `packages/contracts/src/fork/`, `apps/server/src/fork/`,
  `apps/web/src/fork/`, and `docs/fork/`.
- Upstream files only gain imports, one spread per registration list, component mounts, and
  one-line delegations. Every such line carries `// fork:workspaces` (or `{/* fork:workspaces */}`
  in JSX), so `git grep fork:workspaces` lists every touch point.
- Spreads go at the top of upstream lists, because upstream appends to the end.
- Fork tables use their own migration ledger (`fork_schema_migrations`), never upstream's numbered
  `Migrations/NNN_*` files.
- Server guards read `WorkspaceOwnership`, a `Context.Reference` with an empty default, so upstream
  layers and tests run unchanged without the fork layer.
- Upstream web hooks import `apps/web/src/fork/workspaces/registry.ts`, not `state.ts`, so their
  module graphs and test mocks never pull in the connection runtime.

Deleting the tagged lines and the `fork/` folders restores upstream behavior.

## Touch points

| File                                                                              | Why                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/contracts/src/{index,rpc,clientRpcPermissions}.ts`                      | Export and register the workspace RPCs and client scopes.                         |
| `packages/client-runtime/src/rpc/client.ts`                                       | Let clients subscribe to the two workspace streams.                               |
| `apps/server/src/server.ts`, `ws.ts`                                              | Provide the workspace layer and its RPC handlers.                                 |
| `apps/server/src/auth/RpcAuthorization.ts`, `observability/RpcInstrumentation.ts` | Scopes and metrics tags for the new RPCs.                                         |
| `apps/server/src/project/ProjectSetupScriptRunner.ts`                             | A workspace runs its setup once; new chats in it skip the project's setup action. |
| `apps/server/src/git/GitWorkflowService.ts`                                       | Refuse to remove a live workspace's worktree from anywhere but its own archive.   |
| `apps/server/src/storageCleanup.ts`                                               | Cleanup policies keep workspace worktrees.                                        |
| `apps/web/src/components/AppSidebarLayout.tsx`                                    | Mount the workspace sidebar and dialogs.                                          |
| `apps/web/src/components/ChatView.tsx`                                            | Mount the chat tabs under a workspace chat's header.                              |
| `apps/web/src/hooks/useHandleNewThread.ts`                                        | Route new project chats into a workspace and give each workspace its own draft.   |
| `apps/web/src/hooks/useThreadActions.ts`                                          | Deleting a workspace's last chat never offers to delete its worktree.             |
| `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`                        | Chats in a workspace cannot switch to another checkout.                           |

## Merging upstream

1. `git fetch upstream && git merge upstream/main`.
2. Conflicts can only touch the lines above. Re-apply each tagged line where the surrounding code
   moved.
3. Run the fork tests: `vp test run apps/server/src/fork apps/web/src/fork`, then typecheck the
   server and web packages.

To use upstream's sidebar instead, set `t3fork:use-upstream-sidebar` in the browser's localStorage.
That also turns off routing new chats into workspaces.
