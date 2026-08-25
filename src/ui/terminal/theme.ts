import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

/**
 * Terminal adaptation of the OpenDesign "tech-utility" spec (brand-spec.md).
 * OKLch design tokens are converted to hex; the hierarchy is carried by
 * lightness steps (bg → surface → surface-2) instead of shadows, the accent
 * is a line green used for the turn rail and focus states, and thinking is a
 * distinct purple-gray hue that always reads apart from body text.
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
  background: "#080d11",
  surface: "#0f141a",
  surfaceHigh: "#161c23",
  text: "#e3e9ec",
  softText: "#b2bcc2",
  muted: "#7a858d",
  faint: "#616a71",
  thinking: "#b5a4d6",
  thinkingDim: "#817795",
  accent: "#67d3a1",
  accentDim: "#519171",
  accentStrong: "#67d3a1",
  success: "#6fbf8e",
  warning: "#dbb96f",
  error: "#eb837e",
  border: "#21272d",
  borderStrong: "#323940",
  selection: "#d7dde5",
  selectionText: "#111418",
  diffAdded: "#6fbf8e",
  diffRemoved: "#eb837e",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#f6f8f9",
  surface: "#eceff1",
  surfaceHigh: "#e1e6e9",
  text: "#1d2429",
  softText: "#37424b",
  muted: "#6b767f",
  faint: "#98a3ab",
  thinking: "#73639f",
  thinkingDim: "#9085b0",
  accent: "#197e5b",
  accentDim: "#52947a",
  accentStrong: "#166f51",
  success: "#287345",
  warning: "#7f6825",
  error: "#b1423a",
  border: "#d3dade",
  borderStrong: "#bfc9ce",
  selection: "#1d4945",
  selectionText: "#ffffff",
  diffAdded: "#287345",
  diffRemoved: "#b1423a",
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
    "markup.raw": { fg: theme.accent },
    "markup.link": { fg: theme.muted },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.accentDim },
    "markup.quote": { fg: theme.muted, italic: true },
    comment: { fg: theme.muted, italic: true },
    string: { fg: theme.success },
    keyword: { fg: theme.warning, bold: true },
    function: { fg: theme.accent },
    type: { fg: theme.accentDim },
    variable: { fg: theme.softText },
    constant: { fg: theme.warning },
    operator: { fg: theme.muted },
    punctuation: { fg: theme.muted },
  });
}
