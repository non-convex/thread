import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process.js";

/** A Windows rename does not copy the replaced file's DACL to the new file. */
async function copyWindowsAccess(source: string, temporary: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // Pass paths as environment values, never interpolate them into shell code.
  // Copy only access rules, so changing another owner's file does not require
  // ownership or audit privileges. Do this before writing sensitive content.
  await runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", [
    "$ErrorActionPreference = 'Stop'",
    "if (Test-Path -LiteralPath $env:THREAD_ATOMIC_SOURCE) {",
    "  $section = [System.Security.AccessControl.AccessControlSections]::Access",
    "  $sourceAcl = Get-Acl -LiteralPath $env:THREAD_ATOMIC_SOURCE",
    "  $acl = New-Object System.Security.AccessControl.FileSecurity",
    "  $acl.SetSecurityDescriptorSddlForm($sourceAcl.GetSecurityDescriptorSddlForm($section), $section)",
    "  Set-Acl -LiteralPath $env:THREAD_ATOMIC_TEMP -AclObject $acl",
    "}",
  ].join("\n")], {
    env: { ...process.env, THREAD_ATOMIC_SOURCE: source, THREAD_ATOMIC_TEMP: temporary },
    signal: combined,
    maxOutputBytes: 8 * 1024,
  });
  combined.throwIfAborted();
}

/** Persist directory-entry changes where the platform exposes directory fsync. */
export async function syncDirectory(directory: string): Promise<void> {
  // Node/Bun cannot open directory handles for fsync on Windows.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Publish a complete file; failed preparation never truncates the destination. */
export async function atomicFile(file: string, content: string | Uint8Array, options: {
  mode?: number;
  signal?: AbortSignal;
  /** False publishes only if the destination is still absent. */
  overwrite?: boolean;
  /** Recheck authorization and the observed version immediately before publication. */
  beforeCommit?: () => Promise<void>;
} = {}): Promise<void> {
  options.signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true });
  options.signal?.throwIfAborted();
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", options.mode);
  try {
    if (process.platform === "win32" && options.overwrite !== false) {
      await copyWindowsAccess(file, temporary, options.signal);
    }
    await handle.writeFile(content, { signal: options.signal });
    // Apply the exact saved mode before publication, rather than exposing a file
    // with umask-filtered permissions and fixing it afterward.
    if (options.mode !== undefined) await handle.chmod(options.mode);
    await handle.sync();
    await handle.close();
    options.signal?.throwIfAborted();
    await options.beforeCommit?.();
    options.signal?.throwIfAborted();
    if (options.overwrite === false) {
      // An exclusive link publishes the fully written file without replacing a
      // destination another writer created after beforeCommit.
      await link(temporary, file);
      await rm(temporary);
    } else {
      await rename(temporary, file);
    }
    await syncDirectory(path.dirname(file));
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
