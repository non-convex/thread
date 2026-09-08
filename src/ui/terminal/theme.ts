import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

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

const darkTheme: ThreadTerminalTheme = {
  background: "#0B0E14",
  surface: "#161B22",
  surfaceHigh: "#1C2128",
  text: "#B4BCC6",
  softText: "#8B93A0",
  muted: "#6B7280",
  faint: "#5B6369",
  thinking: "#9B8FB8",
  thinkingDim: "#8578A8",
  accent: "#C8936D",
  accentDim: "#B07D57",
  accentStrong: "#D4A582",
  spark: "#C09850",
  sparkAlt: "#5FA068",
  success: "#5FA068",
  warning: "#A8824A",
  error: "#C86B66",
  border: "#262C34",
  borderStrong: "#3A424A",
  selection: "#C8936D",
  selectionText: "#0D1117",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#FFFFFF",
  surface: "#F6F8FA",
  surfaceHigh: "#EFF1F3",
  text: "#1F2328",
  softText: "#57606A",
  muted: "#8C959F",
  faint: "#A8B1BC",
  thinking: "#0969DA",
  thinkingDim: "#218BFF",
  accent: "#EA580C",
  accentDim: "#F97316",
  accentStrong: "#C2410C",
  spark: "#BF8700",
  sparkAlt: "#1A7F37",

  success: "#1A7F37",
  warning: "#9A6700",
  error: "#CF222E",

  border: "#D1D9E0",
  borderStrong: "#ACB6C0",

  selection: "#EA580C",
  selectionText: "#FFFFFF",
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
    "markup.heading": { fg: theme.text, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.softText, italic: true },
    "markup.strikethrough": { fg: theme.muted, dim: true },
    "markup.raw": { fg: theme.accentDim, bg: theme.surface },
    "markup.link": { fg: theme.accent },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.muted },
    "markup.quote": { fg: theme.muted, italic: true },
    comment: { fg: theme.muted, italic: true },
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
