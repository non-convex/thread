import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: readonly string[];
  code: number;
  stdout: Buffer;
  stderr: Buffer;
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
  allowExitCodes?: readonly number[];
  maxOutputBytes?: number;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const result = await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        reject(new Error(`${command} stdout exceeded ${maxOutputBytes} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        child.kill();
        reject(new Error(`${command} stderr exceeded ${maxOutputBytes} bytes`));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        command,
        args,
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input);
    }
  });

  const allowed = options.allowExitCodes ?? [0];
  if (!allowed.includes(result.code)) throw new ProcessError(result);
  return result;
}

export function splitNull(buffer: Buffer): string[] {
  const parts = buffer.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}
