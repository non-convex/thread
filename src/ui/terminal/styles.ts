import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const paint = (open: number, close = 39) => (text: string): string => `\x1b[${open}m${text}\x1b[${close}m`;
const paintRgb = (red: number, green: number, blue: number) => (text: string): string =>
  `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;

export const cyan = paint(36);
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const dim = paint(2, 22);
export const bold = paint(1, 22);
export const italic = paint(3, 23);
export const underline = paint(4, 24);
export const strikethrough = paint(9, 29);
export const inverse = paint(7, 27);
export const accent = paintRgb(126, 190, 183);
export const warm = paintRgb(239, 190, 98);
export const muted = paintRgb(128, 132, 136);
export const softText = paintRgb(207, 210, 213);

export function rule(width: number, char = "─"): string {
  return dim(char.repeat(Math.max(1, width)));
}

export function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…");
}

export function columns(left: string, center: string, right: string, width: number): string {
  if (width < 60) return fit(`${left}  ${right}`, width);
  const safeWidth = Math.max(1, width);
  const leftWidth = visibleWidth(left);
  const centerWidth = visibleWidth(center);
  const rightWidth = visibleWidth(right);
  const centerStart = Math.max(leftWidth + 2, Math.floor((safeWidth - centerWidth) / 2));
  const rightStart = Math.max(centerStart + centerWidth + 2, safeWidth - rightWidth);
  if (rightStart + rightWidth > safeWidth) return fit(`${left}  ${center}  ${right}`, safeWidth);
  return left + " ".repeat(Math.max(1, centerStart - leftWidth)) + center +
    " ".repeat(Math.max(1, rightStart - centerStart - centerWidth)) + right;
}

export function shortId(id: string, length = 10): string {
  const value = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
  return value.length > length ? value.slice(0, length) : value;
}
