import * as HostProcess from "@t3tools/shared/HostProcess";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
  /** Runs once the terminal exists, before the script starts. */
  readonly onOpened?: Effect.Effect<void>;
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

function quoteForShell(value: string, shell: CompletionShell): string {
  switch (shell) {
    case "powershell":
      return `'${value.replaceAll("'", "''")}'`;
    case "fish":
      return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    case "posix":
      return `'${value.replaceAll("'", "'\\''")}'`;
  }
}

/**
 * Runs the script from a file, not typed into the shell: line editors mangle long pastes, and a
 * shebang only works when the kernel executes a file. Scripts without one use the user's shell.
 * The screen is cleared first, and the exit-code sentinel is erased once printed.
 */
export function wrapWorkspaceCommand(
  scriptPath: string,
  hasShebang: boolean,
  shell: CompletionShell,
  sentinel: string,
): string {
  const script = quoteForShell(scriptPath, shell);
  const clearScreen = "printf '\\033[3J\\033[H\\033[2J'";
  const hideSentinel = "\\r\\033[2K\\033[1A";
  switch (shell) {
    case "powershell":
      // A script block, not `& file.ps1`, so the execution policy does not block it.
      return `Clear-Host; $global:LASTEXITCODE = $null; & ([scriptblock]::Create([IO.File]::ReadAllText(${script}))); if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 }; Write-Host "${sentinel}$__t3c"`;
    case "fish":
      return `${clearScreen}; ${hasShebang ? script : `"$SHELL" ${script}`}; printf '\\n${sentinel}%s${hideSentinel}' $status`;
    case "posix":
      return `${clearScreen}; ${hasShebang ? script : `"\${SHELL:-/bin/sh}" ${script}`}; printf '\\n${sentinel}%s${hideSentinel}' "$?"`;
  }
}

function stripTerminalControl(text: string): string {
  return text
    .replace(
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Runs a workspace script in a real terminal so the right panel can show it
 * live, and mirrors its lines into the workspace log for the log dialog.
 */
export const runWorkspaceScript = Effect.fn("ForkWorkspaces.runWorkspaceScript")(function* (
  request: WorkspaceScriptRequest,
) {
  const terminals = yield* TerminalManager.TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const shell = completionShell(yield* HostProcess.Platform, yield* HostProcess.Environment);
  const token = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
  const sentinel = `__T3FORK_DONE_${token}:`;
  const sentinelPattern = new RegExp(`${sentinel}(-?\\d+)`);
  const terminalFailure = (error: { readonly message: string }) =>
    Effect.sync((): WorkspaceScriptResult => {
      request.onOutput(`\n${error.message}\n`);
      return { exitCode: null, timedOut: false };
    });

  // A shebang only counts on the first line, and a script pasted from Windows
  // would otherwise run with a `\r` on every line.
  const script =
    shell === "powershell"
      ? request.command
      : `${request.command.trimStart().replace(/\r\n?/g, "\n")}\n`;
  const hasShebang = shell !== "powershell" && script.startsWith("#!");
  const scriptPath = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "t3-workspace-script-" })
    .pipe(
      Effect.map((directory) =>
        path.join(directory, shell === "powershell" ? "script.ps1" : "script"),
      ),
      Effect.tap((file) => fileSystem.writeFileString(file, script, { mode: 0o700 })),
      Effect.catch((error) => terminalFailure(error).pipe(Effect.as(null))),
    );
  if (scriptPath === null)
    return { exitCode: null, timedOut: false } satisfies WorkspaceScriptResult;
  const commandLine = wrapWorkspaceCommand(scriptPath, hasShebang, shell, sentinel);
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
  if (request.onOpened) yield* request.onOpened;

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
}, Effect.scoped);
