import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

/**
 * Terminal adaptation of the OpenDesign "tech-utility" spec (brand-spec.md).
 * Hierarchy is carried by lightness steps (bg -> surface -> surface-2) instead
 * of shadows: the transcript groups a turn by tinted block rather than a rail,
 * so that one step must read as a boundary without becoming a hard edge.
 *
 * The neutrals are plum-tinted and deliberately low-key, which leaves room for
 * two saturated spark colours. Sparks earn attention by being rare, so they are
 * reserved for one meaning each and never used for static decoration:
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
  background: "#17111a",
  // The turn block uses the lightest step: it only has to hint at grouping, and
  // a heavier tint would compete with the composer for attention.
  surface: "#1f1722",
  surfaceHigh: "#2b1f2f",
  text: "#f5eaf0",
  softText: "#cbb8c4",
  muted: "#9b8794",
  // Lifted above muted's neighbourhood because faint also sits on the composer,
  // the most raised surface, where a darker value falls below AA-large.
  faint: "#8d7a88",
  // Cool blue against the plum neutrals, so thinking never reads as body text.
  thinking: "#8fb8ff",
  thinkingDim: "#7191c9",
  accent: "#ff7a6b",
  accentDim: "#c25f55",
  accentStrong: "#ff9d91",
  spark: "#ffd83d",
  sparkAlt: "#7dffb0",
  code: "#d9c4b8",
  success: "#6ee7a0",
  warning: "#ffb340",
  error: "#ff4d6d",
  // Borders sit above surfaceHigh, since the cards they outline are drawn on the
  // raised surfaces rather than on the base background.
  border: "#3d2d42",
  borderStrong: "#4f3b55",
  selection: "#f5eaf0",
  selectionText: "#17111a",
  diffAdded: "#6ee7a0",
  diffRemoved: "#ff4d6d",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#fdf6f8",
  surface: "#fffbfc",
  surfaceHigh: "#f6ebef",
  text: "#3a2933",
  softText: "#584452",
  muted: "#7a6572",
  faint: "#8f7a87",
  thinking: "#2f5aa8",
  thinkingDim: "#5a7cb8",
  // Coral and gold must be pushed dark on a light background to keep contrast;
  // gold in particular is nearly invisible at its dark-theme value.
  accent: "#c2412f",
  accentDim: "#cf6a5b",
  accentStrong: "#a63424",
  spark: "#8a6410",
  sparkAlt: "#1c7a4a",
  code: "#6b5344",
  success: "#1c7a4a",
  warning: "#8a5a10",
  error: "#c22641",
  border: "#e8d9de",
  borderStrong: "#d4c1c8",
  selection: "#3a2933",
  selectionText: "#fdf6f8",
  diffAdded: "#1c7a4a",
  diffRemoved: "#c22641",
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
    // Inside a fenced block the coral accent is welcome: it is bounded, so the
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
