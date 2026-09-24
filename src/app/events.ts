/** Coding command lifecycle; model execution is observed through runtime.subscribe(). */
export type CommandEvent =
  | { type: "command_started"; name: string }
  | { type: "command_finished"; name: string; ok: boolean };
export type CommandEventSink = (event: CommandEvent) => void | Promise<void>;

export function emitCommandEvent(sink: CommandEventSink | undefined, event: CommandEvent): void {
  try {
    const pending = sink?.(event);
    if (pending) void pending.catch(() => undefined);
  } catch { /* Observers cannot change command execution. */ }
}
