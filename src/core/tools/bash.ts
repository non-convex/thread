import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { runProcess, type ProcessResult } from "../utils/process.js";
import { claim, entireWorkspaceClaim } from "./execution.js";
import type { AgentTool, ToolResult } from "./types.js";

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 300_000;
export const BASH_OUTPUT_LIMIT = 64 * 1024;
const BASH_PREVIEW_BYTES = 16 * 1024;

export interface ShellInvocation {
  command: string;
  args: readonly string[];
}

const GIT_BASH_RELATIVE_PATHS = [
  "Git\\bin\\bash.exe",
  "Git\\usr\\bin\\bash.exe",
] as const;

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function gitBashFromGitExecutable(): string[] {
  const gitPath = which("git");
  if (!gitPath) return [];
  const root = path.dirname(path.dirname(gitPath));
  return [path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe")];
}

function which(executable: string): string | undefined {
  const extensions = (process.env.PATHEXT ?? ".EXE").split(path.delimiter).filter(Boolean);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function powershellInvocation(executable: string, script: string): ShellInvocation {
  return {
    command: executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  };
}

function powershellScript(command: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$PSNativeCommandUseErrorActionPreference = $true",
    command,
    "exit $LASTEXITCODE",
  ].join("; ");
}

function gitBashCandidates(): string[] {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  const override = process.env.THREAD_GIT_BASH;
  const candidates = [
    ...(override ? [override] : []),
    ...gitBashFromGitExecutable(),
    ...roots.flatMap((root) => GIT_BASH_RELATIVE_PATHS.map((relative) => path.join(root, relative))),
  ];
  return [...new Set(candidates)].filter((candidate) => existsSync(candidate));
}

/**
 * Windows shell preference: Git Bash first, so `bash` commands behave as their
 * name promises and match the POSIX shell used on other platforms. PowerShell
 * remains the fallback when no Git Bash is installed — pwsh before
 * powershell.exe, since only pwsh gives UTF-8 output and native exit codes.
 */
export function windowsShellCandidates(command: string): ShellInvocation[] {
  const candidates: ShellInvocation[] = [];
  for (const bash of gitBashCandidates()) {
    candidates.push({ command: bash, args: ["-lc", command] });
  }
  candidates.push(powershellInvocation("pwsh", powershellScript(command)));
  candidates.push(powershellInvocation("powershell.exe", powershellScript(command)));
  return candidates;
}

function isShellLaunchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES" || error.message.startsWith("spawn ");
}

export function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

async function presentBashOutput(result: ProcessResult): Promise<ToolResult> {
  const format = (limit: number) => {
    const stdout = decodeUtf8Tail(result.stdout.subarray(-limit));
    const stderr = decodeUtf8Tail(result.stderr.subarray(-limit));
    return [stdout, ...(stderr ? [`[stderr]\n${stderr}`] : [])].filter(Boolean).join("\n") || "Command completed with no output";
  };
  const captureNotice = result.truncated
    ? `\n\n[Capture limit reached: only the last ${BASH_OUTPUT_LIMIT} bytes of each stream were retained; earlier output is unavailable.]`
    : "";
  const captured = format(BASH_OUTPUT_LIMIT) + captureNotice;
  const details: { exitCode: number; truncated?: boolean; outputPath?: string } = { exitCode: result.code };
  if (result.truncated) details.truncated = true;
  let content = captured;
  if (result.stdout.length > BASH_PREVIEW_BYTES || result.stderr.length > BASH_PREVIEW_BYTES) {
    const outputPath = path.join(tmpdir(), `thread-bash-${randomUUID()}.log`);
    try {
      await writeFile(outputPath, captured, { flag: "wx", mode: 0o600 });
      details.outputPath = outputPath;
      content = `${format(BASH_PREVIEW_BYTES)}\n\n[Showing up to ${BASH_PREVIEW_BYTES} trailing bytes per stream. Captured output saved to: ${outputPath}. Read or search that file for details; do not rerun the command just to retrieve output.]${captureNotice}`;
    } catch (error) {
      content += `\n\n[Could not save captured output: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  return { content, isError: result.code !== 0 || result.killedBySignal === true, details };
}

export const bashTool: AgentTool<{ command: string; timeoutMs?: number }> = {
  name: "bash",
  description:
    `Run a foreground shell command in the workspace. Prefer grep, read, and list for inspecting files, and edit or write for changing them. Detached/background commands are unsupported. Shows up to ${BASH_PREVIEW_BYTES / 1024} KiB from the end of stdout and stderr; longer captured output is saved to a temporary file. Capture is limited to the last 64KB per stream.`,
  parameters: Type.Object({
    command: Type.String(),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: BASH_MAX_TIMEOUT_MS })),
  }),
  replay: "never",
  execution: {
    effect: "process",
    mode: "sequential",
    resources: () => [entireWorkspaceClaim("write"), claim("process", "foreground", "write")],
  },
  async execute(args, context) {
    const timeoutMs = args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout]);
    try {
      const command = args.command.trim();
      if (!command) throw new Error("command cannot be empty");
      const isWindows = process.platform === "win32";
      const shells = isWindows
        ? windowsShellCandidates(command)
        : [{ command: "/bin/sh", args: ["-lc", command] as const }];
      let launchFailure: unknown;
      for (const shell of shells) {
        try {
          const result = await runProcess(shell.command, shell.args, {
            cwd: context.rootPath,
            signal,
            allowExitCodes: "any",
            maxOutputBytes: BASH_OUTPUT_LIMIT,
            overflow: "truncate",
          });
          const output = await presentBashOutput(result);
          if (result.code === 0 && !result.killedBySignal) return output;
          if (timeout.aborted && !context.signal.aborted) {
            output.content += `\n\nCommand timed out after ${Math.round(timeoutMs / 1000)}s`;
          } else if (context.signal.aborted || result.killedBySignal) {
            output.content += "\n\nCommand aborted";
          } else {
            output.content += `\n\nCommand exited with code ${result.code}`;
          }
          return output;
        } catch (error) {
          if (!isWindows || !isShellLaunchFailure(error)) throw error;
          launchFailure = error;
        }
      }
      throw launchFailure instanceof Error
        ? launchFailure
        : new Error("No usable shell was found on this Windows host");
    } catch (error) {
      return fail(error);
    }
  },
};
