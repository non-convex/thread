import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SlashSuggestion } from "./controller.js";

export interface ComposerSuggestion {
  kind: "command" | "path";
  label: string;
  description: string;
  replacement: string;
  start: number;
  end: number;
  cursor: number;
  submit: boolean;
}

interface CachedPathEntry {
  name: string;
  directory: boolean;
}

const DIRECTORY_CACHE_TTL_MS = 750;
const DIRECTORY_CACHE_MAX = 32;
const directoryCache = new Map<string, { expiresAt: number; entries: CachedPathEntry[] }>();

function directoryEntries(directory: string): CachedPathEntry[] {
  const now = Date.now();
  const cached = directoryCache.get(directory);
  if (cached && cached.expiresAt > now) {
    directoryCache.delete(directory);
    directoryCache.set(directory, cached);
    return cached.entries;
  }
  const entries = readdirSync(directory, { withFileTypes: true }).map((entry) => {
    let directoryEntry = entry.isDirectory();
    if (!directoryEntry && entry.isSymbolicLink()) {
      try {
        directoryEntry = statSync(join(directory, entry.name)).isDirectory();
      } catch {
        directoryEntry = false;
      }
    }
    return { name: entry.name, directory: directoryEntry };
  });
  directoryCache.set(directory, { expiresAt: now + DIRECTORY_CACHE_TTL_MS, entries });
  while (directoryCache.size > DIRECTORY_CACHE_MAX) {
    const oldest = directoryCache.keys().next().value;
    if (oldest === undefined) break;
    directoryCache.delete(oldest);
  }
  return entries;
}

function displayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function commandSuggestions(
  input: string,
  cursor: number,
  commands: readonly SlashSuggestion[],
): ComposerSuggestion[] {
  const before = input.slice(0, cursor);
  if (!/^\/[^\s/]*$/.test(before)) return [];
  const query = before.slice(1).toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .map((command) => {
      const replacement = `/${command.name} `;
      return {
        kind: "command",
        label: `/${command.name}`,
        description: command.description,
        replacement,
        start: 0,
        end: cursor,
        cursor: replacement.length,
        submit: true,
      };
    });
}

interface PathPrefix {
  start: number;
  token: string;
  at: boolean;
  quoted: boolean;
  raw: string;
}

function pathPrefix(input: string, cursor: number, force: boolean): PathPrefix | undefined {
  const before = input.slice(0, cursor);
  let quotedStart = -1;
  let openQuote = false;
  for (let index = 0; index < before.length; index++) {
    if (before[index] !== '"' || before[index - 1] === "\\") continue;
    openQuote = !openQuote;
    if (openQuote) quotedStart = before[index - 1] === "@" ? index - 1 : index;
  }
  const delimiter = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t"));
  const start = openQuote ? quotedStart : delimiter + 1;
  const token = before.slice(start);
  if (!token) {
    return force ? { start, token, at: false, quoted: false, raw: token } : undefined;
  }
  const at = token.startsWith("@");
  const withoutAt = at ? token.slice(1) : token;
  const quoted = withoutAt.startsWith('"');
  const raw = quoted ? withoutAt.slice(1) : withoutAt;
  const ambiguousSlashCommand = start === 0 && raw.startsWith("/") && !raw.slice(1).includes("/");
  if (ambiguousSlashCommand && !force) return undefined;
  const naturallyPathLike = at || raw.includes("/") || raw.includes("\\") || raw.startsWith(".") || raw.startsWith("~");
  if (!force && !naturallyPathLike) return undefined;
  return { start, token, at, quoted, raw };
}

function searchLocation(rootPath: string, rawPrefix: string): { directory: string; displayBase: string; query: string } {
  const normalized = displayPath(rawPrefix);
  const slash = normalized.lastIndexOf("/");
  const displayBase = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const query = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  let directory: string;
  if (displayBase.startsWith("~/") || normalized === "~") {
    directory = join(homedir(), displayBase.slice(2));
  } else if (isAbsolute(displayBase || normalized)) {
    directory = displayBase || dirname(normalized);
  } else {
    directory = resolve(rootPath, displayBase || ".");
  }
  return { directory, displayBase, query };
}

function completionValue(prefix: PathPrefix, pathValue: string, directory: boolean): { value: string; cursor: number } {
  const withSlash = directory ? `${pathValue}/` : pathValue;
  const requiresQuote = prefix.quoted || /\s/.test(withSlash);
  const marker = prefix.at ? "@" : "";
  if (!requiresQuote) {
    const value = `${marker}${withSlash}`;
    return { value, cursor: value.length };
  }
  const value = `${marker}"${withSlash}"`;
  return { value, cursor: directory ? value.length - 1 : value.length };
}

function pathSuggestions(input: string, cursor: number, rootPath: string, force: boolean): ComposerSuggestion[] {
  const prefix = pathPrefix(input, cursor, force);
  if (!prefix) return [];
  const { directory, displayBase, query } = searchLocation(rootPath, prefix.raw);
  let entries: CachedPathEntry[];
  try {
    entries = directoryEntries(directory);
  } catch {
    return [];
  }
  const visible = entries
    .filter((entry) => entry.name.toLowerCase().startsWith(query.toLowerCase()))
    .filter((entry) => query.startsWith(".") || !entry.name.startsWith("."))
    .sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name))
    .slice(0, 8);

  return visible.map((entry) => {
    const relative = displayPath(`${displayBase}${entry.name}`);
    const completed = completionValue(prefix, relative, entry.directory);
    return {
      kind: "path",
      label: `${basename(entry.name)}${entry.directory ? "/" : ""}`,
      description: entry.directory ? "directory" : "file",
      replacement: completed.value,
      start: prefix.start,
      end: cursor,
      cursor: prefix.start + completed.cursor,
      submit: false,
    };
  });
}

export function composerSuggestions(options: {
  input: string;
  cursor: number;
  rootPath: string;
  commands: readonly SlashSuggestion[];
  forcePaths?: boolean;
}): ComposerSuggestion[] {
  const commands = commandSuggestions(options.input, options.cursor, options.commands);
  if (commands.length > 0) return commands;
  return pathSuggestions(options.input, options.cursor, options.rootPath, options.forcePaths ?? false);
}

export function applyComposerSuggestion(
  input: string,
  suggestion: ComposerSuggestion,
): { input: string; cursor: number } {
  return {
    input: `${input.slice(0, suggestion.start)}${suggestion.replacement}${input.slice(suggestion.end)}`,
    cursor: suggestion.cursor,
  };
}
