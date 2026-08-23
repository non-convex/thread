import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
  accent,
  bold,
  italic,
  muted,
  softText,
  strikethrough,
  underline,
  warm,
} from "./styles.js";

const markdownTheme: MarkdownTheme = {
  heading: warm,
  link: accent,
  linkUrl: muted,
  code: accent,
  codeBlock: softText,
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: muted,
  hr: muted,
  listBullet: accent,
  bold,
  italic,
  underline,
  strikethrough,
  codeBlockIndent: "  ",
};

interface CachedMarkdown {
  text: string;
  width: number;
  lines: string[];
}

/** Renders model Markdown without pulling pi-coding-agent into the dependency graph. */
export class TerminalMarkdownRenderer {
  private readonly cache = new Map<string, CachedMarkdown>();

  render(key: string, text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const cached = this.cache.get(key);
    if (cached?.text === text && cached.width === safeWidth) return cached.lines;

    const lines = new Markdown(text.trim(), 0, 0, markdownTheme).render(safeWidth)
      .map((line) => line.replace(/\s+$/, ""));
    if (this.cache.size >= 256 && !this.cache.has(key)) this.cache.clear();
    this.cache.set(key, { text, width: safeWidth, lines });
    return lines;
  }
}
