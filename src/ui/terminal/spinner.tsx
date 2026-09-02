import { createSignal, onCleanup } from "solid-js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ANIMATION_INTERVAL_MS = 100;

// Every animated row shares one clock. Independent per-row intervals spread
// render requests across the whole frame and can keep OpenTUI pinned at its
// maximum FPS when several tools run together.
const [animationTime, setAnimationTime] = createSignal(Date.now());
let consumers = 0;
let timer: NodeJS.Timeout | undefined;

function retainAnimationClock(): () => void {
  consumers++;
  if (consumers === 1) {
    setAnimationTime(Date.now());
    timer = setInterval(() => setAnimationTime(Date.now()), ANIMATION_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Reactive wall-clock shared by status elapsed time and every spinner. */
export function tuiAnimationTime(): number {
  return animationTime();
}

export function spinnerFrameAt(timestamp: number): string {
  const index = Math.floor(timestamp / ANIMATION_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index]!;
}

export function SpinnerText(props: { fg: string }) {
  const release = retainAnimationClock();
  onCleanup(release);
  return <text fg={props.fg} width={1} height={1} wrapMode="none">{spinnerFrameAt(tuiAnimationTime())}</text>;
}
