export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Wait for best-effort cleanup without allowing it to block shutdown forever. */
export async function settlesWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns a cheap cooperative yield check scoped to one CPU-heavy operation. */
export function cooperativeYield(intervalMs = 8): (signal?: AbortSignal) => Promise<void> {
  let lastYield = performance.now();
  return async (signal?: AbortSignal) => {
    if (performance.now() - lastYield < intervalMs) return;
    await yieldToEventLoop();
    lastYield = performance.now();
    signal?.throwIfAborted();
  };
}
