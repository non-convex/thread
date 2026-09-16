import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import type { TranscriptTool } from "../state.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

/** Hide explicitly named credential fields; arbitrary command/output text is not a secret scanner. */
export function displayArguments(args: Record<string, unknown>): string {
  return JSON.stringify(args, (key, value: unknown) =>
    /^(authorization|api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token)$/i.test(key) ? "[redacted]" : value, 2);
}

export function toolArguments(tool: TranscriptTool): string {
  const a = tool.args;
  const range = [a.offset !== undefined ? `from ${a.offset}` : "", a.limit !== undefined ? `limit ${a.limit}` : ""].filter(Boolean);
  switch (tool.name) {
    case "read": return [text(a.path), ...range].join(" · ");
    case "list": return [text(a.path) || ".", ...range].join(" · ");
    case "grep": return [
      `${JSON.stringify(a.pattern ?? "")} in ${text(a.path) || "."}`,
      text(a.glob), a.literal === true ? "literal" : "", a.ignoreCase === true ? "ignore case" : "",
      a.outputMode === "files" ? "files only" : "", a.offset ? `page from ${a.offset}` : "",
    ].filter(Boolean).join(" · ");
    case "bash": return text(a.command);
    case "edit": return `${text(a.path)} · ${Array.isArray(a.edits) ? a.edits.length : 0} replacement(s)`;
    case "write": return `${text(a.path)} · ${Buffer.byteLength(text(a.content), "utf8")} bytes`;
    case "webfetch": return [text(a.url), text(a.format), ...range].filter(Boolean).join(" · ");
    case "websearch": return JSON.stringify(a.query ?? "");
    case "session_search": return Array.isArray(a.queries) ? a.queries.map((q) => JSON.stringify(q)).join("; ") : "";
    case "session_read": return [text(a.turnId), ...range,
      ...["thinking", "toolCalls", "toolResults"].filter((key) => a[key] === true),
      a.before ? `before ${a.before}` : "", a.after ? `after ${a.after}` : "",
    ].filter(Boolean).join(" · ");
    default: return displayArguments(a) === "{}" ? "" : displayArguments(a).replace(/\s+/g, " ");
  }
}

export interface ToolPresentation { summary: string; body: string; notice: string; diff: boolean }

export function presentTool(tool: TranscriptTool, content: string): ToolPresentation {
  const d = object(tool.details);
  const result: ToolPresentation = { summary: "", body: "", notice: "", diff: false };
  if (tool.status === "queued" || tool.status === "running") {
    result.summary = tool.status;
    return result;
  }
  if (tool.name === "bash") {
    result.notice = [d.truncated ? "Capture limit reached; earlier output is unavailable" : "",
      d.outputPath ? `Captured output: ${d.outputPath}` : ""].filter(Boolean).join(" · ");
  }
  if (tool.status !== "completed") {
    result.summary = `${tool.status}${tool.name === "bash" && number(d.exitCode) !== undefined ? ` · exit ${d.exitCode}` : ""}`;
    result.body = content;
    return result;
  }
  const shown = number(d.shown);
  const total = number(d.total);
  switch (tool.name) {
    case "read":
      result.summary = shown === undefined ? "read completed" : `${shown} lines read${shown > 0 ? ` · ${d.offset}–${Number(d.offset) + shown - 1}` : ""}`;
      if (d.nextOffset !== undefined) result.notice = `More content available from line ${d.nextOffset}${d.truncatedByBytes ? " · 64 KiB tool limit" : ""}`;
      break;
    case "list":
      result.summary = shown === undefined ? "listing completed" : `${shown}${total !== undefined && total > shown ? ` of ${total}` : ""} entries`;
      if (total !== undefined && shown !== undefined && total > shown) result.notice = "Directory listing limited by the tool";
      break;
    case "grep":
      result.summary = number(d.totalMatches) === undefined ? "search completed"
        : `${d.totalMatches} matches in ${d.totalFiles} files · ${d.shown} shown`;
      result.body = content.split("\n").slice(2).filter((line) => !line.startsWith("[Continue with cursor=") && !line.startsWith("scan capped")).join("\n").trimEnd();
      result.notice = [d.scanCapped ? "Search scan capped; counts are partial" : "", d.nextCursor ? "More results available" : ""].filter(Boolean).join(" · ");
      break;
    case "bash":
      result.summary = number(d.exitCode) === undefined ? "completed" : `exit ${d.exitCode}`;
      result.body = content;
      break;
    case "edit":
    case "write":
      result.summary = tool.name === "edit" ? "applied" : d.existed === true ? "overwritten" : d.existed === false ? "created" : "written";
      if (number(d.additions) !== undefined && number(d.deletions) !== undefined) result.summary += ` · +${d.additions} −${d.deletions}`;
      result.body = text(d.diff);
      result.diff = Boolean(result.body);
      result.notice = text(d.diffUnavailable);
      break;
    case "webfetch":
      result.summary = shown === undefined ? "response received" : `${shown.toLocaleString("en-US")} characters received`;
      if (d.nextOffset !== undefined) result.notice = `More content available at offset ${d.nextOffset}`;
      break;
    case "websearch":
      result.summary = `${text(d.provider) ? `${d.provider} · ` : ""}search returned`;
      break;
    case "session_search": {
      const coverage = object(d.coverage);
      result.summary = number(d.hits) === undefined ? "search completed" : `${d.hits} turns found`;
      result.notice = [coverage.totalTurns !== undefined ? `Keyword coverage ${coverage.keywordTurns}/${coverage.totalTurns} · semantic ${text(d.semantic)}` : "",
        ...(Array.isArray(d.diagnostics) ? d.diagnostics.map(String) : [])].filter(Boolean).join(" · ");
      break;
    }
    case "session_read":
      result.summary = number(d.shownBytes) === undefined ? "history read" : `${d.shownBytes} bytes read`;
      if (d.nextOffset !== undefined) result.notice = `More history available at offset ${d.nextOffset}`;
      break;
    default:
      result.body = content;
  }
  return result;
}

export function cleanToolText(content: string): string {
  return stripVTControlCharacters(content).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").trimEnd();
}

export function formatToolText(content: string): string {
  const clean = cleanToolText(content);
  if (!/^[\s]*[\[{]/.test(clean)) return clean;
  try { return JSON.stringify(JSON.parse(clean), null, 2); } catch { return clean; }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Bound previews by terminal columns, including wide characters and long single-line output. */
export function toolPreview(content: string, width: number, maxRows: number, tail = false): { text: string; clipped: boolean } {
  const columns = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  for (const line of content.split("\n")) {
    let row = "";
    let used = 0;
    for (const { segment } of graphemes.segment(line)) {
      const size = stringWidth(segment);
      if (used + size > columns && row) { rows.push(row); row = ""; used = 0; }
      row += segment;
      used += size;
    }
    rows.push(row);
  }
  if (rows.length <= maxRows) return { text: rows.join("\n"), clipped: false };
  if (!tail || maxRows < 4) return { text: rows.slice(0, maxRows).join("\n"), clipped: true };
  return { text: [...rows.slice(0, 2), "…", ...rows.slice(-(maxRows - 3))].join("\n"), clipped: true };
}
