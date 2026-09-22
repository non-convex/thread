import { createSignal, type Accessor } from "solid-js";

export interface TranscriptExpansion {
  expanded: Accessor<boolean>;
  toggle: () => void;
}

/** Session-local UI state survives unmounting rows outside the viewport. */
export function createTranscriptExpansion() {
  const states = new Map<string, TranscriptExpansion>();
  return (id: string): TranscriptExpansion => {
    let state = states.get(id);
    if (!state) {
      const [expanded, setExpanded] = createSignal(false);
      state = { expanded, toggle: () => setExpanded((value) => !value) };
      states.set(id, state);
    }
    return state;
  };
}
