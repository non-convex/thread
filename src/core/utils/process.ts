import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: readonly string[];
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated?: boolean;
  /** Capture ended before stdout and stderr reached EOF. */
  outputIncomplete?: boolean;
  killedBySignal?: boolean;
}

export class ProcessError extends Error {
  readonly result: ProcessResult;

  constructor(result: ProcessResult) {
    const stderr = result.stderr.toString("utf8").trim();
    super(`${result.command} exited with code ${result.code}${stderr ? `: ${stderr}` : ""}`);
    this.name = "ProcessError";
    this.result = result;
  }
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  signal?: AbortSignal;
  allowExitCodes?: readonly number[] | "any";
  maxOutputBytes?: number;
  overflow?: "kill" | "truncate";
  /** Consume stdout as it arrives instead of buffering it. The consumer owns its size limit. */
  onStdout?: (chunk: Buffer) => void;
}

class ByteTail {
  private readonly chunks: Buffer[] = [];
  private stored = 0;
  dropped = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.stored += chunk.length;
    while (this.stored > this.max && this.chunks.length > 0) {
      this.dropped = true;
      const excess = this.stored - this.max;
      const oldest = this.chunks[0]!;
      if (oldest.length <= excess) {
        this.chunks.shift();
        this.stored -= oldest.length;
      } else {
        this.chunks[0] = oldest.subarray(excess);
        this.stored -= excess;
      }
    }
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const WINDOWS_OUTPUT_DRAIN_MS = 500;
const ABORT_SETTLE_MS = 1_000;

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      .on("error", () => undefined)
      .unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const overflow = options.overflow ?? "kill";
  const result = await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      clearTimeout(abortTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      fn();
    };

    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutTail = new ByteTail(maxOutputBytes);
    const stderrTail = new ByteTail(maxOutputBytes);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedBySignal = false;

    const complete = (code: number | null): void => {
      if (settled) return;
      const processResult: ProcessResult = {
        command,
        args,
        code: code ?? -1,
        stdout: stdoutTail.concat(),
        stderr: stderrTail.concat(),
      };
      if (stdoutTail.dropped || stderrTail.dropped) processResult.truncated = true;
      if (!child.stdout!.readableEnded || !child.stderr!.readableEnded) processResult.outputIncomplete = true;
      if (killedBySignal) processResult.killedBySignal = true;
      finish(() => resolve(processResult));
    };

    const terminate = (): void => {
      // An exited Windows parent cannot identify its detached descendants.
      // On Unix the process group can still exist after its leader exits.
      if (child.pid !== undefined && (!exited || process.platform !== "win32")) killProcessTree(child.pid);
    };

    const onAbort = (): void => {
      if (settled || killedBySignal) return;
      killedBySignal = true;
      // Killing the parent does not guarantee EOF on inherited output pipes.
      abortTimer = setTimeout(() => complete(exitCode), ABORT_SETTLE_MS);
      terminate();
    };

    const overflowKill = (stream: "stdout" | "stderr"): void => {
      terminate();
      finish(() => reject(new Error(`${command} ${stream} exceeded ${maxOutputBytes} bytes`)));
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (options.onStdout) {
        try {
          options.onStdout(chunk);
        } catch (error) {
          terminate();
          finish(() => reject(error));
        }
        return;
      }
      if (overflow === "truncate") {
        stdoutTail.push(chunk);
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflowKill("stdout");
        return;
      }
      stdoutTail.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (overflow === "truncate") {
        stderrTail.push(chunk);
        return;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        overflowKill("stderr");
        return;
      }
      stderrTail.push(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      if (settled || process.platform !== "win32") return;
      // Windows daemons can inherit the caller's pipe handles, preventing
      // `close` forever. Allow queued output to drain, then release our ends.
      // This is a bounded capture window, not a lossless-output guarantee.
      drainTimer = setTimeout(() => complete(code), WINDOWS_OUTPUT_DRAIN_MS);
    });
    child.once("close", complete);
    child.stdin!.on("error", () => undefined);
    if (options.input === undefined) {
      child.stdin!.end();
    } else {
      child.stdin!.end(options.input);
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort);
    }
  });

  const allowed = options.allowExitCodes ?? [0];
  if (allowed !== "any" && !allowed.includes(result.code)) throw new ProcessError(result);
  return result;
}
