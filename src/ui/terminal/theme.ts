import { SyntaxStyle, createTextAttributes, type ThemeMode } from "@opentui/core";

/**
 * Deep Space Blue + Vibrant Orange: Professional development tool theme
 * based on deep navy blue and vibrant orange accents.
 * 
 * Design philosophy:
 * - Deep navy blue background (#0B0E14) - more refined than pure black
 * - High contrast cool white text for readability
 * - Vibrant orange accent (#F97316) for headings and emphasis - warm and attention-grabbing
 * - Gold spark for "in progress" states
 * - Emerald green sparkAlt for "selected" states
 * 
 * Visual hierarchy achieved through progressive brightening:
 * background → surface → surfaceHigh
 * 
 * Borders have two intensity levels: border (light) and borderStrong (strong).
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
  /** Gold: work in progress. Use sparingly. */
  spark: string;
  /** Emerald green: user's current selection. Use sparingly. */
  sparkAlt: string;
  /** Inline code and literals: readable but not attention-seeking. */
  code: string;
  success: string;
  warning: string;
  error: string;
  border: string;
  borderStrong: string;
  selection: string;
  selectionText: string;
}

const darkTheme: ThreadTerminalTheme = {
  // Deep navy blue background - modern and professional
  background: "#0B0E14",
  
  // Turn blocks use slightly brightened surfaces to establish hierarchy
  surface: "#161B22",
  surfaceHigh: "#1C2128",
  
  // Much softer text system - lower contrast like Codex
  // Main text is softer gray, not bright white
  text: "#B4BCC6",           // Reduced from #D0D7DE - softer main text
  softText: "#8B93A0",       // Reduced from #B1BAC4 - less bright
  muted: "#6B7280",          // Reduced from #7D8590 - more muted
  faint: "#5B6369",          // Reduced from #6E7781 - fainter
  
  // Thinking uses very soft lavender - barely noticeable
  thinking: "#9B8FB8",       // Reduced from #B4A7D6 - much softer purple
  thinkingDim: "#8578A8",    // Dimmer
  
  // Accent: very soft warm orange - low saturation
  accent: "#C8936D",         // Reduced from #E9A06D - much softer
  accentDim: "#B07D57",      // Less saturated
  accentStrong: "#D4A582",   // Softer strong variant
  
  // Spark: muted gold - not eye-catching
  spark: "#C09850",          // Reduced from #E0A850
  
  // SparkAlt: muted green
  sparkAlt: "#5FA068",       // Reduced from #6EBD75
  
  // Code text uses neutral gray - very low contrast
  code: "#8B93A0",           // Same as softText
  
  // Semantic colors: significantly muted
  success: "#5FA068",        // Muted green
  warning: "#A8824A",        // Muted amber
  error: "#C86B66",          // Muted red (not bright)
  
  // Borders: very subtle
  border: "#262C34",         // Reduced from #30363D - barely visible
  borderStrong: "#3A424A",   // Reduced from #484F58
  
  // Selection state
  selection: "#C8936D",
  selectionText: "#0D1117",
};

const lightTheme: ThreadTerminalTheme = {
  // Pure white background, clean and refreshing
  background: "#FFFFFF",
  surface: "#F6F8FA",
  surfaceHigh: "#EFF1F3",
  
  // Dark text system
  text: "#1F2328",
  softText: "#57606A",
  muted: "#8C959F",
  faint: "#A8B1BC",
  
  // Thinking blue needs to be deeper on light background
  thinking: "#0969DA",
  thinkingDim: "#218BFF",
  
  // Accent: deep orange series
  accent: "#EA580C",
  accentDim: "#F97316",
  accentStrong: "#C2410C",
  
  // Spark: gold also needs to be darker on light background
  spark: "#BF8700",
  sparkAlt: "#1A7F37",
  
  code: "#57606A",
  
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
    // Inline code with subtle background and softer accent color
    "markup.raw": { fg: theme.accentDim, bg: theme.surface },
    "markup.link": { fg: theme.accent },
    // Link labels and list markers are structural
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted, underline: true },
    "markup.list": { fg: theme.muted },
    "markup.quote": { fg: theme.muted, italic: true },
    comment: { fg: theme.muted, italic: true },
    // Semantic colors in code blocks
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

// ─────────────────────────────────────────────────────────────────────────
// Visual enhancement utilities
// ─────────────────────────────────────────────────────────────────────────

/**
 * 8-cell precision context meter with sub-cell gradients and dynamic colors.
 * Returns formatted meter string; caller applies color based on percentage.
 */
export function contextMeter(percent: number, cells = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const exact = (clamped / 100) * cells;
  const filled = Math.floor(exact);
  const partial = exact - filled;
  
  let result = "█".repeat(filled);
  
  // Use sub-cell characters for increased precision
  if (filled < cells) {
    if (partial > 0.66) result += "▓";
    else if (partial > 0.33) result += "▒";
    else if (partial > 0) result += "░";
  }
  
  // Fill remaining spaces
  const remaining = Math.max(0, cells - filled - (partial > 0 ? 1 : 0));
  result += "░".repeat(remaining);
  
  return result;
}

/**
 * Return color based on context usage percentage:
 * 0-60%: muted (normal)
 * 60-80%: warning (caution)
 * 80-100%: error (alert)
 */
export function contextMeterColor(percent: number, theme: ThreadTerminalTheme): string {
  if (percent >= 80) return theme.error;
  if (percent >= 60) return theme.warning;
  return theme.muted;
}

/**
 * Status icons - using Unicode characters for clear visual feedback
 */
export const STATUS_ICONS = {
  success: "✓",
  error: "✗",
  running: "◌",
  pending: "○",
  expanded: "▾",
  collapsed: "▸",
  selected: "▸",
  current: "●",
  info: "ⓘ",
  warning: "⚠",
  sparkle: "✦",
  code: "⌘",
  json: "{ }",
} as const;

/**
 * Format token count (k/M)
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * Format duration
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${ms}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m${remainingSeconds}s`;
}

/**
 * Detect content type for intelligent display
 */
export type ContentType = "json" | "code" | "text";

export function detectContentType(content: string): ContentType {
  const trimmed = content.trim();
  
  // JSON detection: format + parsability
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && 
      (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON, continue
    }
  }
  
  // Code detection: keywords and syntax features
  if (/^(import |export |function |const |let |var |class |interface |type |=>|\{[\s\S]*\}|<[\s\S]*>)/m.test(trimmed)) {
    return "code";
  }
  
  return "text";
}

/**
 * Format JSON with proper indentation
 */
export function formatJson(content: string): string {
  try {
    const parsed = JSON.parse(content.trim());
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}
