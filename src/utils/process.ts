import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: readonly string[];
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated?: boolean;
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
      if (this.chunks.length === 1) {
        const buffer = this.chunks[0]!;
        this.chunks[0] = buffer.subarray(Math.max(0, buffer.length - this.max));
        this.stored = this.chunks[0]!.length;
        break;
      }
      const removed = this.chunks.shift()!;
      this.stored -= removed.length;
    }
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
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
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const overflow = options.overflow ?? "kill";
  const result = await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
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

    const onAbort = (): void => {
      killedBySignal = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
    };

    const overflowKill = (stream: "stdout" | "stderr"): void => {
      if (child.pid !== undefined) killProcessTree(child.pid);
      finish(() => reject(new Error(`${command} ${stream} exceeded ${maxOutputBytes} bytes`)));
    };

    child.stdout!.on("data", (chunk: Buffer) => {
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
    child.once("close", (code) => {
      const processResult: ProcessResult = {
        command,
        args,
        code: code ?? -1,
        stdout: stdoutTail.concat(),
        stderr: stderrTail.concat(),
      };
      if (stdoutTail.dropped || stderrTail.dropped) processResult.truncated = true;
      if (killedBySignal) processResult.killedBySignal = true;
      finish(() => resolve(processResult));
    });
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

export function splitNull(buffer: Buffer): string[] {
  const parts = buffer.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}
