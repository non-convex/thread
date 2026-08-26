import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { ProcessError, runProcess } from "../utils/process.js";
import { resolveWorkspacePath } from "./path-safety.js";
import { ToolRegistry, type AgentTool, type ToolResult } from "./types.js";
import { webFetchTool, webSearchTool } from "./web.js";

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

function limited(value: string, max = DEFAULT_OUTPUT_LIMIT): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  return `${Buffer.from(value, "utf8").subarray(0, max).toString("utf8")}\n[output truncated at ${max} bytes]`;
}

function ok(content: string, details?: unknown): ToolResult {
  return { content, isError: false, ...(details === undefined ? {} : { details }) };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

const readTool: AgentTool<{ path: string }> = {
  name: "read",
  description: "Read a UTF-8 text file inside the workspace.",
  parameters: Type.Object({ path: Type.String() }),
  replay: "safe",
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const target = await resolveWorkspacePath(context.rootPath, args.path);
      return ok(limited(await readFile(target, "utf8")));
    } catch (error) {
      return fail(error);
    }
  },
};

const listTool: AgentTool<{ path?: string }> = {
  name: "list",
  description: "List one workspace directory.",
  parameters: Type.Object({ path: Type.Optional(Type.String()) }),
  replay: "safe",
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const target = await resolveWorkspacePath(context.rootPath, args.path ?? ".");
      const entries = await readdir(target, { withFileTypes: true });
      const content = entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"} ${entry.name}`)
        .join("\n");
      return ok(limited(content));
    } catch (error) {
      return fail(error);
    }
  },
};

const grepTool: AgentTool<{ pattern: string; path?: string }> = {
  name: "grep",
  description: "Search workspace text with ripgrep.",
  parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
  replay: "safe",
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const target = await resolveWorkspacePath(context.rootPath, args.path ?? ".");
      const result = await runProcess(
        "rg",
        ["--line-number", "--no-heading", "--color", "never", "--", args.pattern, target],
        { cwd: context.rootPath, signal: context.signal, allowExitCodes: [0, 1], maxOutputBytes: DEFAULT_OUTPUT_LIMIT },
      );
      return ok(limited(result.stdout.toString("utf8")));
    } catch (error) {
      return fail(error);
    }
  },
};

const writeTool: AgentTool<{ path: string; content: string }> = {
  name: "write",
  description: "Create or replace a UTF-8 file inside the workspace.",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  replay: "never",
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const target = await resolveWorkspacePath(context.rootPath, args.path, true);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, args.content, "utf8");
      return ok(`Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`);
    } catch (error) {
      return fail(error);
    }
  },
};

const editTool: AgentTool<{ path: string; oldText: string; newText: string }> = {
  name: "edit",
  description: "Replace one exact, unique text occurrence in a workspace file.",
  parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
  replay: "never",
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      if (!args.oldText) throw new Error("oldText cannot be empty");
      const target = await resolveWorkspacePath(context.rootPath, args.path, true);
      const content = await readFile(target, "utf8");
      const first = content.indexOf(args.oldText);
      if (first < 0) throw new Error("oldText was not found");
      if (content.indexOf(args.oldText, first + args.oldText.length) >= 0) {
        throw new Error("oldText occurs more than once; provide a more specific edit");
      }
      await writeFile(target, `${content.slice(0, first)}${args.newText}${content.slice(first + args.oldText.length)}`, "utf8");
      return ok(`Edited ${args.path}`);
    } catch (error) {
      return fail(error);
    }
  },
};

export interface ShellInvocation {
  command: string;
  args: readonly string[];
}

const GIT_BASH_RELATIVE_PATHS = [
  "Git\\bin\\bash.exe",
  "Git\\usr\\bin\\bash.exe",
] as const;

/**
 * Git Bash locations derived from `git` on PATH. Installations outside
 * `%ProgramFiles%` are common (a different drive, a portable checkout), and
 * `git.exe` usually sits in `<root>\cmd` or `<root>\bin`, so its parent's parent
 * is the install root. `bash.exe` on PATH is deliberately not consulted: on
 * Windows that name is normally the WSL launcher, not Git Bash.
 */
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

/**
 * Builds a PowerShell command that exits with the last native command's code
 * and emits UTF-8. PowerShell 7.3+ also promotes native non-zero exits to
 * errors, while older versions still rely on the final `exit $LASTEXITCODE`.
 */
function powershellScript(command: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$PSNativeCommandUseErrorActionPreference = $true",
    command,
    "exit $LASTEXITCODE",
  ].join("; ");
}

/**
 * Git Bash candidates, most specific first: an explicit `THREAD_GIT_BASH`
 * override, then the installation that owns `git` on PATH, then the standard
 * `%ProgramFiles%` locations.
 */
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

const bashTool: AgentTool<{ command: string; timeoutMs?: number }> = {
  name: "bash",
  description: "Run a foreground shell command in the workspace. Detached/background commands are unsupported.",
  parameters: Type.Object({
    command: Type.String(),
    timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 300_000 })),
  }),
  replay: "never",
  async execute(args, context) {
    const timeout = AbortSignal.timeout(args.timeoutMs ?? 120_000);
    const signal = AbortSignal.any([context.signal, timeout]);
    try {
      const isWindows = process.platform === "win32";
      const shells = isWindows
        ? windowsShellCandidates(args.command)
        : [{ command: "/bin/sh", args: ["-lc", args.command] as const }];
      let launchFailure: unknown;
      for (const shell of shells) {
        try {
          const result = await runProcess(shell.command, shell.args, {
            cwd: context.rootPath,
            signal,
            allowExitCodes: [0],
            maxOutputBytes: DEFAULT_OUTPUT_LIMIT,
          });
          const stdout = result.stdout.toString("utf8").trim();
          const stderr = result.stderr.toString("utf8").trim();
          const content = [
            stdout,
            ...(stderr ? [`[stderr]\n${stderr}`] : []),
          ].filter(Boolean).join("\n");
          return ok(limited(content || "Command completed with no output"), { exitCode: result.code });
        } catch (error) {
          if (!isWindows || !isShellLaunchFailure(error)) throw error;
          launchFailure = error;
        }
      }
      throw launchFailure instanceof Error
        ? launchFailure
        : new Error("No usable shell was found on this Windows host");
    } catch (error) {
      if (error instanceof ProcessError) {
        const stdout = error.result.stdout.toString("utf8").trim();
        const details = stdout ? `stdout:\n${stdout}` : "";
        return {
          content: `${error.message}${details ? `\n${details}` : ""}`,
          isError: true,
        };
      }
      return fail(error);
    }
  },
};

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of [readTool, listTool, grepTool, writeTool, editTool, bashTool, webSearchTool, webFetchTool]) {
    registry.register(tool);
  }
}
