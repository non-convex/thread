import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

export interface ThreadTerminalTheme {
  background: string;
  surface: string;
  surfaceHigh: string;
  text: string;
  toolCallText: string;
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
  nameAccent: string;
  toolNameAccent: string;
  runningAccent: string;
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

// Warm ink: charcoal or paper grounds, amber hierarchy, and one cool sage for activity.
const darkTheme: ThreadTerminalTheme = {
  background: "#171513",
  surface: "#23201C",
  surfaceHigh: "#2E2A24",
  text: "#DDD3C4",
  toolCallText: "#C4B9A9",
  softText: "#AEA293",
  muted: "#8C8274",
  faint: "#6B635A",
  diffAdded: "#A3AE7E",
  diffRemoved: "#C58A7C",
  thinking: "#B4A6C2",
  thinkingDim: "#8E849C",
  accent: "#D9A45B",
  accentDim: "#B08A5E",
  accentStrong: "#EBC07D",
  nameAccent: "#D7825A",
  toolNameAccent: "#BCA784",
  runningAccent: "#9CB5A8",
  spark: "#8FBCB0",
  sparkAlt: "#EACB94",
  success: "#A0B27A",
  warning: "#DCC06A",
  error: "#D7897F",
  border: "#332E28",
  borderStrong: "#4A433A",
  selection: "#4A423A",
  selectionText: "#F2E8D8",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#FBF8F2",
  surface: "#F2EDE3",
  surfaceHigh: "#E9E2D5",
  text: "#3A342C",
  toolCallText: "#4D463C",
  softText: "#625A4E",
  muted: "#766D60",
  faint: "#8F8575",
  diffAdded: "#5F7040",
  diffRemoved: "#A35A4B",
  thinking: "#6C5F85",
  thinkingDim: "#81779A",
  accent: "#A8671E",
  accentDim: "#8E6A45",
  accentStrong: "#8A5212",
  nameAccent: "#B8522B",
  toolNameAccent: "#8A7650",
  runningAccent: "#4F7468",
  spark: "#3E7A6C",
  sparkAlt: "#8A5A1E",
  success: "#5C7A3A",
  warning: "#9C7A1F",
  error: "#B04A45",
  border: "#E3DCCF",
  borderStrong: "#CFC5B4",
  selection: "#E6DCC8",
  selectionText: "#2E281F",
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

/** Gutter marks of the document-flow transcript. */
export const TRANSCRIPT_MARKS = {
  user: "❯",
  reply: "●",
  thinking: "∴",
  note: "◇",
  result: "⎿",
} as const;

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
