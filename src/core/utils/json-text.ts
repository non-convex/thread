/** Serialize JSON-compatible history values in bounded text chunks, without building the whole document. */
export function* jsonTextChunks(value: unknown, indent: 0 | 2 = 0): Generator<string> {
  const active = new Set<object>();
  const omitted = (item: unknown) => item === undefined || typeof item === "function" || typeof item === "symbol";

  function* string(text: string): Generator<string> {
    yield '"';
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 8 * 1024);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
          text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
      yield JSON.stringify(text.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  }

  function* encode(item: unknown, depth: number): Generator<string> {
    if (typeof item === "string") { yield* string(item); return; }
    if (item === null || typeof item !== "object") {
      const encoded = JSON.stringify(item);
      if (encoded !== undefined) yield encoded;
      return;
    }
    if (active.has(item)) throw new TypeError("Converting circular structure to JSON");
    active.add(item);
    try {
      const padding = indent ? " ".repeat(depth * indent) : "";
      const childLine = indent ? `\n${padding}${" ".repeat(indent)}` : "";
      let first = true;
      if (Array.isArray(item)) {
        yield "[";
        for (let index = 0; index < item.length; index++) {
          yield (first ? "" : ",") + childLine;
          first = false;
          if (omitted(item[index])) yield "null";
          else yield* encode(item[index], depth + 1);
        }
        if (!first && indent) yield `\n${padding}`;
        yield "]";
      } else {
        yield "{";
        for (const name in item) {
          if (!Object.prototype.hasOwnProperty.call(item, name)) continue;
          const child: unknown = (item as Record<string, unknown>)[name];
          if (omitted(child)) continue;
          yield (first ? "" : ",") + childLine;
          first = false;
          yield* string(name);
          yield indent ? ": " : ":";
          yield* encode(child, depth + 1);
        }
        if (!first && indent) yield `\n${padding}`;
        yield "}";
      }
    } finally { active.delete(item); }
  }

  yield* encode(value, 0);
}
