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
  thinking: "#b39edc",
  thinkingDim: "#807399",
  accent: "#59e1a2",
  accentDim: "#499971",
  accentStrong: "#59e1a2",
  success: "#65c98c",
  warning: "#e8be62",
  error: "#f97770",
  border: "#21272d",
  borderStrong: "#323940",
  selection: "#d7dde5",
  selectionText: "#111418",
  diffAdded: "#65c98c",
  diffRemoved: "#f97770",
};

const lightTheme: ThreadTerminalTheme = {
  background: "#f6f8f9",
  surface: "#eceff1",
  surfaceHigh: "#e1e6e9",
  text: "#1d2429",
  softText: "#37424b",
  muted: "#6b767f",
  faint: "#98a3ab",
  thinking: "#6f5ba7",
  thinkingDim: "#8d80b5",
  accent: "#0d8a5f",
  accentDim: "#4a9c7c",
  accentStrong: "#0b7a54",
  success: "#1e7d43",
  warning: "#8a6d1a",
  error: "#c0352b",
  border: "#d3dade",
  borderStrong: "#bfc9ce",
  selection: "#174f49",
  selectionText: "#ffffff",
  diffAdded: "#1e7d43",
  diffRemoved: "#c0352b",
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
