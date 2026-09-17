import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { cooperativeYield } from "../utils/async.js";

export const ACCEPT_HEADERS = {
  markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
  text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
  html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
};
const SKIPPED_TAGS = ["script", "style", "noscript", "iframe", "object", "embed"];

/** Bound the decoded response even when Content-Length is missing or incorrect. */
export async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response too large (exceeds ${maxBytes} bytes)`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response too large (exceeds ${maxBytes} bytes)`);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

export function textualMime(mime: string): boolean {
  return !mime || mime.startsWith("text/") || /\+(json|xml)$/.test(mime) ||
    ["application/json", "application/xml", "application/javascript", "application/x-javascript"].includes(mime);
}

export async function extractTextFromHtmlResponsive(html: string, signal: AbortSignal): Promise<string> {
  const text: string[] = [];
  let skippedDepth = 0;
  const parser = new Parser({
    onopentag(name) { if (skippedDepth > 0 || SKIPPED_TAGS.includes(name)) skippedDepth++; },
    ontext(value) { if (skippedDepth === 0) text.push(value); },
    onclosetag() { if (skippedDepth > 0) skippedDepth--; },
  });
  const maybeYield = cooperativeYield();
  const chunkCharacters = 64 * 1024;
  for (let offset = 0; offset < html.length; offset += chunkCharacters) {
    parser.write(html.slice(offset, offset + chunkCharacters));
    await maybeYield(signal);
  }
  parser.end();
  return text.join("").trim();
}

export function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", hr: "---", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*" });
  turndown.remove([...SKIPPED_TAGS, "meta", "link"] as Parameters<TurndownService["remove"]>[0]);
  return turndown.turndown(html);
}

export function pageContent(value: string, offset: number, limit: number) {
  if (offset > 0 && offset >= value.length) throw new Error(`Offset ${offset} is beyond the response (${value.length} characters)`);
  const splitsCharacter = (index: number) =>
    value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff &&
    value.charCodeAt(index) >= 0xdc00 && value.charCodeAt(index) <= 0xdfff;
  if (splitsCharacter(offset)) throw new Error("Offset splits a character; use the continuation offset from the previous result");
  let end = Math.min(value.length, offset + limit);
  if (splitsCharacter(end)) end--;
  if (end === offset && end < value.length) throw new Error("Page limit cannot fit the next character; use limit >= 2");
  const more = end < value.length;
  const notice = offset > 0 || more
    ? `\n\n[Showing character offsets ${offset}–${end} of ${value.length} (end exclusive). ${more
      ? `Use offset=${end} with the same URL and format only if more content is needed. Each call fetches the URL again.` : "End of response."}]` : "";
  return { content: value.slice(offset, end) + notice, offset, shown: end - offset, totalCharacters: value.length,
    ...(more ? { nextOffset: end } : {}) };
}
