export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

/** Sort a large array in bounded synchronous runs, then merge cooperatively. */
export async function cooperativeSort<T>(
  values: T[],
  compare: (left: T, right: T) => number,
  runSize = 4_096,
): Promise<void> {
  const chunkSize = Math.max(1, Math.floor(runSize));
  if (values.length <= chunkSize) {
    values.sort(compare);
    return;
  }
  const maybeYield = cooperativeYield();
  let runs: T[][] = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    runs.push(values.slice(offset, offset + chunkSize).sort(compare));
    await maybeYield();
  }
  while (runs.length > 1) {
    const mergedRuns: T[][] = [];
    for (let index = 0; index < runs.length; index += 2) {
      const left = runs[index]!;
      const right = runs[index + 1];
      if (!right) {
        mergedRuns.push(left);
        continue;
      }
      const merged: T[] = [];
      let leftIndex = 0;
      let rightIndex = 0;
      while (leftIndex < left.length || rightIndex < right.length) {
        if (rightIndex >= right.length ||
            (leftIndex < left.length && compare(left[leftIndex]!, right[rightIndex]!) <= 0)) {
          merged.push(left[leftIndex++]!);
        } else {
          merged.push(right[rightIndex++]!);
        }
        if (merged.length % chunkSize === 0) await maybeYield();
      }
      mergedRuns.push(merged);
      await maybeYield();
    }
    runs = mergedRuns;
  }
  const sorted = runs[0]!;
  for (let offset = 0; offset < sorted.length; offset += chunkSize) {
    const end = Math.min(sorted.length, offset + chunkSize);
    for (let index = offset; index < end; index++) values[index] = sorted[index]!;
    await maybeYield();
  }
}
