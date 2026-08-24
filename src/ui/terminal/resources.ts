import type { SyntaxStyle } from "@opentui/core";
import type { ThreadTerminalTheme } from "./theme.js";

export interface ThreadViewResources {
  theme: ThreadTerminalTheme;
  syntaxStyle: SyntaxStyle;
}
