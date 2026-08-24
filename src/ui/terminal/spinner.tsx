import { createSignal, onCleanup } from "solid-js";

/**
 * Braille spinner frames from the design prototype. Each mounted SpinnerText
 * ticks its own 80ms interval, so an idle screen never re-renders — the
 * interval is unref'd and disposed with the component.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

export function SpinnerText(props: { fg: string }) {
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  onCleanup(() => clearInterval(timer));
  return <text fg={props.fg} width={1} height={1} wrapMode="none">{SPINNER_FRAMES[frame()]!}</text>;
}
