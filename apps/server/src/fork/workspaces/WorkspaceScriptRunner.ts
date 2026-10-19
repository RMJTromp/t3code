import * as HostProcess from "@t3tools/shared/HostProcess";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as TerminalManager from "../../terminal/Manager.ts";

/** Retained per workspace; older output is dropped from the front. */
export const WORKSPACE_LOG_MAX_CHARS = 256 * 1024;
const SCRIPT_TIMEOUT = "30 minutes";
const PARTIAL_LINE_MAX_CHARS = 4_096;

export interface WorkspaceScriptRequest {
  /** The chat whose terminal shows the run; the right panel attaches to it. */
  readonly threadId: string;
  readonly terminalId: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onOutput: (text: string) => void;
}

export interface WorkspaceScriptResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export function trimWorkspaceLog(log: string): string {
  return log.length <= WORKSPACE_LOG_MAX_CHARS ? log : log.slice(-WORKSPACE_LOG_MAX_CHARS);
}

type CompletionShell = "posix" | "fish" | "powershell";

function completionShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): CompletionShell {
  if (platform === "win32") return "powershell";
  const name = (env.SHELL ?? "").split("/").at(-1) ?? "";
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return "posix";
}

/**
 * Same wrapping as upstream's setup runner: the shell reads the whole block
 * before running it, so the script cannot swallow the sentinel, and the
 * sentinel carries the exit code. Unlike upstream, the user sees only their
 * script: the screen (shell startup noise and the echoed wrapper) is cleared
 * first, and the sentinel line is erased right after it is printed.
 */
export function wrapWorkspaceCommand(
  command: string,
  shell: CompletionShell,
  sentinel: string,
): string {
  const body = command.replace(/\r?\n/g, "\r");
  const clearScreen = "printf '\\033[3J\\033[H\\033[2J'";
  const hideSentinel = "\\r\\033[2K\\033[1A";
  switch (shell) {
    case "powershell":
      return `Clear-Host; $global:LASTEXITCODE = $null; & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 }; Write-Host "${sentinel}$__t3c"`;
    case "fish":
      return `${clearScreen}; begin\r${body}\rend; printf '\\n${sentinel}%s${hideSentinel}' $status`;
    case "posix":
      return `${clearScreen}; ( ${body}\r); printf '\\n${sentinel}%s${hideSentinel}' "$?"`;
  }
}

function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex -- removing control characters is the point.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

/**
 * Runs a workspace script in a real terminal so the right panel can show it
 * live, and mirrors its lines into the workspace log for the log dialog.
 */
export const runWorkspaceScript = Effect.fn("ForkWorkspaces.runWorkspaceScript")(function* (
  request: WorkspaceScriptRequest,
) {
  const terminals = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;
  const shell = completionShell(yield* HostProcess.Platform, yield* HostProcess.Environment);
  const token = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
  const sentinel = `__T3FORK_DONE_${token}:`;
  const sentinelPattern = new RegExp(`${sentinel}(-?\\d+)`);
  const commandLine = wrapWorkspaceCommand(request.command, shell, sentinel);
  const echoedWrapperLines = commandLine.split("\r").filter((line) => line.length > 0);
  const done = yield* Deferred.make<number | null>();
  let partial = "";

  const handleLine = (rawLine: string) => {
    const match = sentinelPattern.exec(rawLine);
    if (match) {
      const parsed = Number(match[1]);
      return Deferred.succeed(done, Number.isFinite(parsed) ? parsed : null).pipe(Effect.asVoid);
    }
    const cleaned = stripTerminalControl(rawLine).trimEnd();
    if (
      cleaned.length > 0 &&
      !cleaned.includes(sentinel) &&
      !echoedWrapperLines.some((echoed) => cleaned.endsWith(echoed))
    ) {
      request.onOutput(`${cleaned}\n`);
    }
    return Effect.void;
  };

  const terminalFailure = (error: { readonly message: string }) =>
    Effect.sync((): WorkspaceScriptResult => {
      request.onOutput(`\n${error.message}\n`);
      return { exitCode: null, timedOut: false };
    });

  const opened = yield* terminals
    .open({
      threadId: request.threadId,
      terminalId: request.terminalId,
      cwd: request.cwd,
      worktreePath: request.cwd,
      // Truecolor probes wait for replies nobody sends before a client attaches.
      env: { ...request.env, COLORTERM: "" },
    })
    .pipe(
      Effect.as(true),
      Effect.catch((error) => terminalFailure(error).pipe(Effect.as(false))),
    );
  if (!opened) return { exitCode: null, timedOut: false } satisfies WorkspaceScriptResult;

  // Subscribe before writing so the sentinel cannot race past the listener.
  const unsubscribe = yield* terminals.subscribe((event) => {
    if (event.threadId !== request.threadId || event.terminalId !== request.terminalId) {
      return Effect.void;
    }
    if (event.type === "output") {
      partial += event.data;
      // A bare carriage return is how installers redraw a progress line.
      const lines = partial.split(/\r\n|\r|\n/);
      partial = (lines.pop() ?? "").slice(-PARTIAL_LINE_MAX_CHARS);
      return Effect.forEach(lines, handleLine, { discard: true });
    }
    if (event.type === "exited" || event.type === "closed") {
      return Deferred.succeed(done, null).pipe(Effect.asVoid);
    }
    return Effect.void;
  });

  return yield* terminals
    .write({
      threadId: request.threadId,
      terminalId: request.terminalId,
      data: projectScriptTerminalInput(commandLine),
    })
    .pipe(
      Effect.andThen(
        Deferred.await(done).pipe(
          Effect.map((exitCode): WorkspaceScriptResult => ({ exitCode, timedOut: false })),
          Effect.timeoutOrElse({
            duration: SCRIPT_TIMEOUT,
            orElse: () =>
              Effect.sync((): WorkspaceScriptResult => {
                request.onOutput(`\nStopped waiting after ${SCRIPT_TIMEOUT}.\n`);
                return { exitCode: null, timedOut: true };
              }),
          }),
        ),
      ),
      Effect.catch(terminalFailure),
      Effect.ensuring(Effect.sync(unsubscribe)),
    );
});
