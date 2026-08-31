import { readFile, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { getThreadHome } from "../config/model-config.js";

/** Agent Skills spec caps. */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Directory names never descended into while discovering skills. */
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md (or bare .md) file that declares the skill. */
  filePath: string;
  /** Directory the skill's relative references resolve against. */
  baseDir: string;
  /** Skill body with frontmatter stripped. */
  content: string;
  /** Excluded from the system prompt and the skill tool; only a slash command can load it. */
  disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
  kind: "invalid" | "collision" | "unreadable";
  message: string;
  path: string;
}

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

/** User-level skill root. Project-level and third-party ecosystem roots are deliberately not scanned. */
export function skillsDirectory(): string {
  return path.join(getThreadHome(), "skills");
}

interface Frontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

/**
 * Minimal scalar frontmatter reader. A skill header only carries `name`,
 * `description` and `disable-model-invocation`, so a dependency-free parser is
 * enough; anything structured (nested maps, block scalars, flow sequences) is
 * reported rather than half-understood.
 */
export function parseSkillFrontmatter(
  source: string,
): { frontmatter: Frontmatter; body: string; error?: string } {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: normalized.trim(), error: "frontmatter is not terminated by ---" };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^[^\n]*\n?/, "").trim();
  const frontmatter: Frontmatter = {};
  for (const rawLine of header.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      return { frontmatter, body, error: "frontmatter must be flat key: value pairs" };
    }
    const separator = line.indexOf(":");
    if (separator <= 0) return { frontmatter, body, error: `cannot parse frontmatter line: ${line}` };
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (value === undefined) return { frontmatter, body, error: `cannot parse value for ${key}` };
    if (key === "name") frontmatter.name = value;
    if (key === "description") frontmatter.description = value;
    if (key === "disable-model-invocation") frontmatter.disableModelInvocation = value === "true";
  }
  return { frontmatter, body };
}

function unquote(value: string): string | undefined {
  if (value.startsWith("[") || value.startsWith("{") || value === "|" || value === ">") return undefined;
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Validates against the Agent Skills spec. Directory skills are addressed by
 * their parent directory; loose files are addressed by their filename stem.
 */
function validate(
  name: string,
  description: string | undefined,
  expectedName: string,
  sourceKind: "directory" | "file",
): string[] {
  const errors: string[] = [];
  if (name !== expectedName) errors.push(`name "${name}" does not match its ${sourceKind} "${expectedName}"`);
  if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push("name must use lowercase letters, digits and hyphens only");
  if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  if (!description || !description.trim()) errors.push("description is required");
  else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return errors;
}

async function loadSkillFile(filePath: string): Promise<{ skill?: Skill; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  const declared = path.basename(filePath) === "SKILL.md";
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    return {
      diagnostics: [{
        kind: "unreadable",
        message: error instanceof Error ? error.message : String(error),
        path: filePath,
      }],
    };
  }
  const parsed = parseSkillFrontmatter(source);
  if (parsed.error) {
    // A bare .md file without usable frontmatter is simply not a skill; only a
    // file that declares itself as SKILL.md is worth complaining about.
    if (declared) diagnostics.push({ kind: "invalid", message: parsed.error, path: filePath });
    return { diagnostics };
  }
  const description = parsed.frontmatter.description;
  if (!declared && (!description || !description.trim())) return { diagnostics };

  const baseDir = path.dirname(filePath);
  const expectedName = declared
    ? path.basename(baseDir)
    : path.basename(filePath, path.extname(filePath));
  const name = parsed.frontmatter.name?.trim() || expectedName;
  const errors = validate(name, description, expectedName, declared ? "directory" : "file");
  for (const message of errors) diagnostics.push({ kind: "invalid", message, path: filePath });
  /* Rejected rather than loaded-with-warnings: the name is how the model and the
   * slash command address a skill, so an invalid one is not reliably callable, and
   * admitting it would let a skill sidestep the naming rules that keep names
   * unambiguous. */
  if (errors.length > 0) return { diagnostics };
  const trimmedDescription = description?.trim();
  if (!trimmedDescription) return { diagnostics };

  return {
    skill: {
      name,
      description: trimmedDescription,
      filePath,
      baseDir,
      content: parsed.body,
      disableModelInvocation: parsed.frontmatter.disableModelInvocation === true,
    },
    diagnostics,
  };
}

async function entryKind(
  parent: string,
  entry: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<"file" | "directory" | undefined> {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const info = await stat(path.join(parent, entry.name));
    return info.isFile() ? "file" : info.isDirectory() ? "directory" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A directory holding SKILL.md is a skill root and is not descended into, so a
 * skill may keep scripts and reference material in subdirectories without those
 * being mistaken for further skills.
 */
async function scanDirectory(dir: string, includeLooseFiles: boolean): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      diagnostics.push({
        kind: "unreadable",
        message: error instanceof Error ? error.message : String(error),
        path: dir,
      });
    }
    return { skills, diagnostics };
  }

  const declaring = entries.find((entry) => entry.name === "SKILL.md");
  if (declaring && (await entryKind(dir, declaring)) === "file") {
    const result = await loadSkillFile(path.join(dir, "SKILL.md"));
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const kind = await entryKind(dir, entry);
    const fullPath = path.join(dir, entry.name);
    if (kind === "directory") {
      const nested = await scanDirectory(fullPath, false);
      skills.push(...nested.skills);
      diagnostics.push(...nested.diagnostics);
      continue;
    }
    if (kind !== "file" || !includeLooseFiles || !entry.name.endsWith(".md")) continue;
    const result = await loadSkillFile(fullPath);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

/**
 * Discovers user-level skills once. The result is folded into the system prompt,
 * which must stay byte-stable for a Session Tree's lifetime, so callers load at
 * startup and never rescan mid-session.
 */
export async function loadSkills(directory = skillsDirectory()): Promise<LoadedSkills> {
  const found = await scanDirectory(directory, true);
  const byName = new Map<string, Skill>();
  const seenPaths = new Set<string>();
  const diagnostics = [...found.diagnostics];
  for (const skill of found.skills) {
    let canonical = skill.filePath;
    try {
      canonical = await realpath(skill.filePath);
    } catch {
      /* keep the literal path when it cannot be resolved */
    }
    if (seenPaths.has(canonical)) continue;
    const existing = byName.get(skill.name);
    if (existing) {
      diagnostics.push({
        kind: "collision",
        message: `skill name "${skill.name}" is already defined by ${existing.filePath}`,
        path: skill.filePath,
      });
      continue;
    }
    byName.set(skill.name, skill);
    seenPaths.add(canonical);
  }
  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    diagnostics,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * System-prompt section advertising what can be loaded. Only name, description
 * and location are listed: the bodies stay out of the prefix until the model asks
 * for one, which is the whole point of progressive disclosure.
 */
export function formatSkillsSection(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "## Skills",
    "",
    "These skills carry task-specific instructions. When a task matches one of the",
    "descriptions below, call the `skill` tool with that name to load its full",
    "instructions before proceeding. Paths inside a skill resolve against the",
    "directory reported when it loads.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}
