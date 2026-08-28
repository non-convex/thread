import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

/**
 * Warm forest palette: olive-umber neutrals, sand text, and muted orange,
 * gold and moss pastels. Hierarchy is carried by lightness steps
 * (bg -> surface -> surface-2) instead of shadows: the transcript groups a
 * turn by tinted block rather than a rail, so that one step must read as a
 * boundary without becoming a hard edge.
 *
 * Neutrals stay low-key so two sparks can earn attention by being rare. They
 * are reserved for one meaning each and never used for static decoration:
 *
 *   spark     "happening right now" - spinners, the live composer border, cursor
 *   sparkAlt  "your selection is here" - selected rows, the current-item marker
 *
 * accent stays the low-key primary for turn labels, headings and static hints.
 * Semantic colours are independent of both and only signal outcome.
 */
export interface ThreadTerminalTheme {
  background: string;
  surface: string;
  surfaceHigh: string;
  text: string;
  softText: string;
  muted: string;
  faint: string;
  thinking: string;
  thinkingDim: string;
  accent: string;
  accentDim: string;
  accentStrong: string;
  /** Bright spark: work in progress. Rare by design. */
  spark: string;
  /** Bright spark: the user's current selection. Rare by design. */
  sparkAlt: string;
  /** Inline code and literals in replies: readable, deliberately not attention-seeking. */
  code: string;
  success: string;
  warning: string;
  error: string;
  border: string;
  borderStrong: string;
  selection: string;
  selectionText: string;
  diffAdded: string;
  diffRemoved: string;
}

const darkTheme: ThreadTerminalTheme = {
  // Olive, not coffee: a warm grey-green canvas reads calmer than brown and
  // lets the sand text sit without halating.
  background: "#2e332b",
  // The turn block uses the lightest step: it only has to hint at grouping, and
  // a heavier tint would compete with the composer for attention.
  surface: "#373d34",
  surfaceHigh: "#41483e",
  text: "#d3c9bb",
  softText: "#b5afa0",
  muted: "#9c9a88",
  // Lifted above muted's neighbourhood because faint also sits on the composer,
  // the most raised surface, where a darker value falls below AA-large.
  faint: "#8c8a7a",
  // Soft teal against the warm neutrals, so thinking never reads as body text.
  thinking: "#86b0a8",
  thinkingDim: "#6d948c",
  accent: "#e0996f",
  accentDim: "#bf7d58",
  accentStrong: "#edb28c",
  spark: "#ddbc7e",
  sparkAlt: "#a9c083",
  code: "#c6b28c",
  success: "#96b374",
  warning: "#d2a75e",
  error: "#e07b78",
  // Borders sit above surfaceHigh, since the cards they outline are drawn on the
  // raised surfaces rather than on the base background.
  border: "#4b5347",
  borderStrong: "#5a6355",
  selection: "#d3c9bb",
  selectionText: "#2e332b",
  diffAdded: "#96b374",
  diffRemoved: "#e07b78",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#f7f2e7",
  surface: "#fcf8ef",
  surfaceHigh: "#ece5d4",
  text: "#3f4433",
  softText: "#5d6150",
  muted: "#7e8271",
  faint: "#8f9280",
  thinking: "#3e7285",
  thinkingDim: "#5f8794",
  // Orange and gold must be pushed dark on cream to keep contrast;
  // gold in particular is nearly invisible at its dark-theme value.
  accent: "#b85d33",
  accentDim: "#c97d54",
  accentStrong: "#9d4e2a",
  spark: "#8f6f2e",
  sparkAlt: "#56703a",
  code: "#7a6238",
  success: "#4f7a3a",
  warning: "#8a6320",
  error: "#b34a48",
  border: "#ddd4bd",
  borderStrong: "#c8bda2",
  selection: "#3f4433",
  selectionText: "#f7f2e7",
  diffAdded: "#4f7a3a",
  diffRemoved: "#b34a48",
};

export const bold = createTextAttributes({ bold: true });
export const dim = createTextAttributes({ dim: true });
export const italic = createTextAttributes({ italic: true });
export const dimItalic = createTextAttributes({ dim: true, italic: true });
export const boldDim = createTextAttributes({ bold: true, dim: true });

export function terminalTheme(mode: ThemeMode | null | undefined): ThreadTerminalTheme {
  return mode === "light" ? lightTheme : darkTheme;
}

export function createThreadSyntaxStyle(theme: ThreadTerminalTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    conceal: { fg: theme.muted, dim: true },
    "markup.heading": { fg: theme.text, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.softText, italic: true },
    "markup.strikethrough": { fg: theme.muted, dim: true },
    // Inline code appears constantly in replies, so it takes the quiet warm sand
    // rather than the accent, which would turn a normal paragraph into noise.
    "markup.raw": { fg: theme.code },
    "markup.link": { fg: theme.muted },
    // Link labels and list bullets are structural, not emphatic: an underline and
    // a dim marker are enough, and colouring every bullet would tint whole lists.
    "markup.link.label": { fg: theme.code, underline: true },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.muted },
    "markup.quote": { fg: theme.muted, italic: true },
    comment: { fg: theme.muted, italic: true },
    // Inside a fenced block the soft orange accent is welcome: it is bounded, so the
    // colour reads as syntax rather than as emphasis leaking into prose.
    string: { fg: theme.success },
    keyword: { fg: theme.accent, bold: true },
    function: { fg: theme.accentStrong },
    type: { fg: theme.thinking },
    variable: { fg: theme.softText },
    constant: { fg: theme.warning },
    operator: { fg: theme.muted },
    punctuation: { fg: theme.muted },
  });
}
