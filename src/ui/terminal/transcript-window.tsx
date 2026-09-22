import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { batch, createMemo, createSignal, For, onCleanup, type Accessor, type JSX } from "solid-js";

interface Viewport {
  anchor: string | undefined;
  inset: number;
  top: number;
  height: number;
  bottom: boolean;
}

/** Only visible transcript blocks and one screen of overscan own native text buffers. */
export function TranscriptWindow<T extends { id: string }>(props: {
  items: readonly T[];
  scroll: Accessor<ScrollBoxRenderable | undefined>;
  estimateHeight?: (item: T) => number;
  children: (item: Accessor<T>) => JSX.Element;
}) {
  const renderer = useRenderer();
  const heights = new Map<string, number>();
  const nodes = new Map<string, BoxRenderable>();
  const [revision, setRevision] = createSignal(0);
  const [viewport, setViewport] = createSignal<Viewport>({
    anchor: undefined, inset: 0, top: 0, height: renderer.height, bottom: true,
  });
  let container: BoxRenderable | undefined;
  let width = 0;
  let restore: Viewport | undefined;
  let lastScrollTop: number | undefined;
  let previousLayout: ReturnType<typeof layout> | undefined;
  const layout = createMemo(() => {
    revision();
    const items = props.items;
    const byId = new Map(items.map((item, index) => [item.id, { item, index }]));
    for (const id of heights.keys()) if (!byId.has(id)) heights.delete(id);
    const offsets = [0];
    for (const item of items) {
      offsets.push(offsets.at(-1)! + (heights.get(item.id) ?? Math.max(1, props.estimateHeight?.(item) ?? 8)));
    }
    return { items, byId, offsets, total: offsets.at(-1)! };
  });

  const indexAt = (offsets: readonly number[], y: number) => {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (offsets[middle]! <= y) low = middle;
      else high = middle - 1;
    }
    return Math.min(low, Math.max(0, offsets.length - 2));
  };
  const range = createMemo(() => {
    const data = layout();
    const view = viewport();
    const anchor = view.anchor === undefined ? undefined : data.byId.get(view.anchor);
    const top = view.bottom ? Math.max(0, data.total - view.height)
      : anchor ? data.offsets[anchor.index]! + view.inset : Math.min(view.top, Math.max(0, data.total - view.height));
    const start = indexAt(data.offsets, Math.max(0, top - view.height));
    const end = Math.min(data.items.length, indexAt(data.offsets, top + view.height * 2) + 1);
    return { start, end, before: data.offsets[start]!, after: data.total - data.offsets[end]! };
  });
  const visible = createMemo(() => layout().items.slice(range().start, range().end).map((item) => item.id));

  // Consume wheel/PageUp changes before applying a simultaneous streaming update.
  // Otherwise the old bottom anchor would undo the user's attempt to scroll up.
  const beforeFrame = async () => {
    const scroll = props.scroll();
    if (!scroll || lastScrollTop === undefined || scroll.scrollTop === lastScrollTop || !previousLayout) return;
    const view = viewport();
    const top = Math.max(0, view.top + scroll.scrollTop - lastScrollTop);
    const index = indexAt(previousLayout.offsets, top);
    restore = undefined;
    setViewport({
      anchor: previousLayout.items[index]?.id, inset: top - previousLayout.offsets[index]!, top,
      height: scroll.viewport.height,
      bottom: scroll.scrollTop >= Math.max(0, scroll.scrollHeight - scroll.viewport.height) - 1,
    });
  };

  // Layout measurements arrive after Yoga has placed the rows. Preserve the first
  // visible block when estimates change, including after wrapping on resize.
  const synchronize = () => {
    const scroll = props.scroll();
    if (!scroll || !container || scroll.viewport.height < 1) return;
    const data = layout();
    const view = restore ?? (previousLayout !== data ? viewport() : undefined);
    if (view) {
      if (view.bottom) scroll.scrollTo(scroll.scrollHeight);
      else {
        const node = view.anchor === undefined ? undefined : nodes.get(view.anchor);
        if (node) scroll.scrollBy(node.y - scroll.viewport.y + view.inset);
      }
    }
    restore = undefined;
    previousLayout = data;
    const top = Math.max(0, scroll.viewport.y - container.y);
    const height = scroll.viewport.height;
    const bottom = scroll.scrollTop >= Math.max(0, scroll.scrollHeight - height) - 1;
    let anchor: string | undefined;
    let inset = 0;
    for (const id of visible()) {
      const node = nodes.get(id);
      if (node && node.height > 0 && node.y + node.height > scroll.viewport.y) {
        anchor = id;
        inset = scroll.viewport.y - node.y;
        break;
      }
    }
    const next = { anchor, inset, top, height, bottom };
    let changed = width !== container.width;
    if (changed) {
      width = container.width;
      heights.clear();
    }
    for (const [id, node] of nodes) {
      if (node.height > 0 && heights.get(id) !== node.height) {
        heights.set(id, node.height);
        changed = true;
      }
    }
    const old = viewport();
    batch(() => {
      if (old.anchor !== anchor || old.inset !== inset || old.top !== top || old.height !== height || old.bottom !== bottom) {
        setViewport(next);
      }
      if (changed) {
        restore = next;
        setRevision((value) => value + 1);
      }
    });
    lastScrollTop = scroll.scrollTop;
  };
  renderer.setFrameCallback(beforeFrame);
  renderer.on("frame", synchronize);
  onCleanup(() => {
    renderer.removeFrameCallback(beforeFrame);
    renderer.off("frame", synchronize);
  });

  return <box ref={(node) => { container = node; }} width="100%" flexDirection="column" flexShrink={0}>
    <box height={range().before} flexShrink={0} />
    <For each={visible()}>{(id) => {
      const item = () => layout().byId.get(id)!.item;
      onCleanup(() => nodes.delete(id));
      return <box id={`transcript-row:${id}`} ref={(node) => { nodes.set(id, node); }}
        width="100%" flexDirection="column" flexShrink={0} minHeight={1}>
        {props.children(item)}
      </box>;
    }}</For>
    <box height={range().after} flexShrink={0} />
  </box>;
}
