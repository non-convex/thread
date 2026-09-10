import path from "node:path";

export async function startRuntimeProcess(mode: "raw" | "idle" | "running", rootPath: string, stateDirectory: string) {
  let ready!: (message: { sessionId?: string }) => void;
  const started = new Promise<{ sessionId?: string }>((resolve) => { ready = resolve; });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "runtime-process.ts"), mode, rootPath, stateDirectory], {
    stdout: "ignore", stderr: "pipe", ipc: (message) => { if (message?.ready) ready(message); },
  });
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const message = await Promise.race([started, child.exited.then(async (code) => {
      throw new Error(`Runtime fixture exited (${code}): ${await stderr}`);
    })]);
    return { child, ...message };
  } finally { clearTimeout(timer); }
}
