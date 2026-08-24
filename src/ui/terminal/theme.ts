import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

export interface ThreadTerminalTheme {
  background: string;
  surface: string;
  text: string;
  softText: string;
  muted: string;
  thinking: string;
  accent: string;
  accentStrong: string;
  success: string;
  warning: string;
  error: string;
  border: string;
  selection: string;
  selectionText: string;
  diffAdded: string;
  diffRemoved: string;
}

const darkTheme: ThreadTerminalTheme = {
  background: "#0b0d10",
  surface: "#14181d",
  text: "#d9dde3",
  softText: "#b8bec7",
  muted: "#747c87",
  thinking: "#8b8496",
  accent: "#7ebeb7",
  accentStrong: "#55d6c2",
  success: "#72c472",
  warning: "#efbe62",
  error: "#ef7373",
  border: "#343b45",
  selection: "#d7dde5",
  selectionText: "#111418",
  diffAdded: "#76c893",
  diffRemoved: "#ef767a",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#f7f8fa",
  surface: "#eceff3",
  text: "#20252b",
  softText: "#3d4650",
  muted: "#707985",
  thinking: "#6d6478",
  accent: "#147d73",
  accentStrong: "#006f63",
  success: "#247a3c",
  warning: "#9a6500",
  error: "#b4232c",
  border: "#c8cdd4",
  selection: "#174f49",
  selectionText: "#ffffff",
  diffAdded: "#287c44",
  diffRemoved: "#b42e37",
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
    "markup.heading": { fg: theme.warning, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.softText, italic: true },
    "markup.strikethrough": { fg: theme.muted, dim: true },
    "markup.raw": { fg: theme.accentStrong },
    "markup.link": { fg: theme.muted },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.accent },
    "markup.quote": { fg: theme.muted, italic: true },
    comment: { fg: theme.muted, italic: true },
    string: { fg: theme.success },
    keyword: { fg: theme.warning, bold: true },
    function: { fg: theme.accentStrong },
    type: { fg: theme.accent },
    variable: { fg: theme.softText },
    constant: { fg: theme.warning },
    operator: { fg: theme.muted },
    punctuation: { fg: theme.muted },
  });
}
