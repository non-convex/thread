import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

export interface ThreadTerminalTheme {
  background: string;
  surface: string;
  surfaceHigh: string;
  text: string;
  softText: string;
  muted: string;
  faint: string;
  diffAdded: string;
  diffRemoved: string;
  thinking: string;
  thinkingDim: string;
  accent: string;
  accentDim: string;
  accentStrong: string;
  spark: string;
  sparkAlt: string;
  success: string;
  warning: string;
  error: string;
  border: string;
  borderStrong: string;
  selection: string;
  selectionText: string;
}

// Keep the original neutral backgrounds; mint, cyan and blue-grey define the foreground hierarchy.
const darkTheme: ThreadTerminalTheme = {
  background: "#0B0E14",
  surface: "#161B22",
  surfaceHigh: "#1C2128",
  text: "#C0CACF",
  softText: "#98A7AE",
  muted: "#7D8B95",
  faint: "#606D78",
  diffAdded: "#84AC95",
  diffRemoved: "#B78794",
  thinking: "#9FAAD0",
  thinkingDim: "#7F8CAA",
  accent: "#80CCB2",
  accentDim: "#70A996",
  accentStrong: "#ADE6CF",
  spark: "#83C4D4",
  sparkAlt: "#B4DEC1",
  success: "#90BD9C",
  warning: "#C6AB78",
  error: "#D48F98",
  border: "#262C34",
  borderStrong: "#3A424A",
  selection: "#3A424A",
  selectionText: "#DEEAE4",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#FFFFFF",
  surface: "#F6F8FA",
  surfaceHigh: "#EFF1F3",
  text: "#2B3B3E",
  softText: "#4F626A",
  muted: "#63747C",
  faint: "#75838D",
  diffAdded: "#4D755E",
  diffRemoved: "#996471",
  thinking: "#5B6E93",
  thinkingDim: "#6B7891",
  accent: "#26765F",
  accentDim: "#4A7766",
  accentStrong: "#165E4B",
  spark: "#2E7385",
  sparkAlt: "#386F52",
  success: "#497653",
  warning: "#916B34",
  error: "#A75261",
  border: "#D1D9E0",
  borderStrong: "#ACB6C0",
  selection: "#D1D9E0",
  selectionText: "#253D36",
};

export const bold = createTextAttributes({ bold: true });
export const dim = createTextAttributes({ dim: true });
export const italic = createTextAttributes({ italic: true });
export const dimItalic = createTextAttributes({ dim: true, italic: true });

export function terminalTheme(mode: ThemeMode | null | undefined): ThreadTerminalTheme {
  return mode === "light" ? lightTheme : darkTheme;
}

export function createThreadSyntaxStyle(theme: ThreadTerminalTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    conceal: { fg: theme.muted, dim: true },
    "markup.heading": { fg: theme.accentStrong, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.softText, italic: true },
    "markup.strikethrough": { fg: theme.muted, dim: true },
    "markup.raw": { fg: theme.accentDim },
    "markup.link": { fg: theme.accent },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.muted },
    "markup.quote": { fg: theme.softText, italic: true },
    comment: { fg: theme.muted, italic: true },
    string: { fg: theme.success },
    keyword: { fg: theme.accent, bold: true },
    function: { fg: theme.spark },
    type: { fg: theme.thinking },
    variable: { fg: theme.softText },
    constant: { fg: theme.warning },
    operator: { fg: theme.muted },
    punctuation: { fg: theme.muted },
  });
}

export function contextMeter(percent: number, cells = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const exact = (clamped / 100) * cells;
  const filled = Math.floor(exact);
  const partial = exact - filled;

  let result = "█".repeat(filled);
  if (filled < cells) {
    if (partial > 0.66) result += "▓";
    else if (partial > 0.33) result += "▒";
    else if (partial > 0) result += "░";
  }
  const remaining = Math.max(0, cells - filled - (partial > 0 ? 1 : 0));
  result += "░".repeat(remaining);

  return result;
}

export function contextMeterColor(percent: number, theme: ThreadTerminalTheme): string {
  if (percent >= 80) return theme.error;
  if (percent >= 60) return theme.warning;
  return theme.muted;
}

export const STATUS_ICONS = {
  success: "✓",
  error: "✗",
  running: "◌",
  expanded: "▾",
  collapsed: "▸",
  selected: "▸",
  current: "●",
  info: "ⓘ",
} as const;

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
