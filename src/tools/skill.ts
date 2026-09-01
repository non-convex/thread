import { readdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Skill } from "../skills/loader.js";
import { singletonResource } from "./execution.js";
import type { AgentTool, ToolResult } from "./types.js";

/**
 * Skill bodies are instructions, so truncation keeps the head: the opening of a
 * skill states its purpose and preconditions, while a lost tail costs detail.
 * This is the opposite of `bash`, where the tail carries the outcome.
 */
export const SKILL_CONTENT_LIMIT = 32 * 1024;

/** Sampled companion files, enough to reveal a skill's scripts and references. */
const SKILL_FILE_SAMPLE = 20;

function truncateHead(content: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf8") <= SKILL_CONTENT_LIMIT) return { text: content, truncated: false };
  const cut = Buffer.from(content, "utf8").subarray(0, SKILL_CONTENT_LIMIT);
  return { text: cut.toString("utf8"), truncated: true };
}

/**
 * Companion files inside the skill directory, so relative references in the body
 * resolve to something the model can see without a separate listing round.
 * Directories are reported with a trailing separator and never descended into.
 */
async function sampleSkillFiles(baseDir: string): Promise<{ entries: string[]; remainder: number }> {
  let names: string[];
  try {
    const found = await readdir(baseDir, { withFileTypes: true });
    names = found
      .filter((entry) => entry.name !== "SKILL.md" && !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return { entries: [], remainder: 0 };
  }
  return {
    entries: names.slice(0, SKILL_FILE_SAMPLE),
    remainder: Math.max(0, names.length - SKILL_FILE_SAMPLE),
  };
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

/**
 * Loads one skill body on demand. Kept separate from `read` because a skill must
 * arrive whole and self-describing: `read` pages by line count and would silently
 * cut instructions, and it cannot report the base directory that the skill's own
 * relative paths depend on.
 */
export function createSkillTool(skills: () => readonly Skill[]): AgentTool<{ name: string }> {
  return {
    name: "skill",
    description:
      "Load the full instructions of a skill listed in the system prompt. Call this when the task matches a skill's description, before doing the work.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name exactly as listed in available_skills." }),
    }),
    replay: "safe",
    execution: {
      effect: "read",
      mode: "parallel",
      resources: (args) => singletonResource("skills", args.name.trim(), "read"),
    },
    async execute(args, context) {
      context.signal.throwIfAborted();
      const requested = args.name.trim();
      if (!requested) return fail("name cannot be empty");
      const available = skills().filter((skill) => !skill.disableModelInvocation);
      const skill = available.find((candidate) => candidate.name === requested);
      if (!skill) {
        const names = available.map((candidate) => candidate.name).join(", ");
        return fail(`Unknown skill: ${requested}. Available skills: ${names || "(none)"}`);
      }
      const body = truncateHead(skill.content);
      const files = await sampleSkillFiles(skill.baseDir);
      const lines = [
        `<skill name="${skill.name}" location="${skill.filePath}">`,
        body.text.trim(),
        ...(body.truncated ? ["", `[Skill body truncated at ${SKILL_CONTENT_LIMIT} bytes.]`] : []),
        "",
        `Base directory: ${skill.baseDir}`,
        "Relative paths in these instructions resolve against that directory; pass absolute paths to tools.",
      ];
      if (files.entries.length > 0) {
        lines.push(
          "",
          "<skill_files>",
          ...files.entries.map((entry) => `  ${path.join(skill.baseDir, entry)}`),
          ...(files.remainder > 0 ? [`  … ${files.remainder} more entr${files.remainder === 1 ? "y" : "ies"}`] : []),
          "</skill_files>",
        );
      }
      lines.push("</skill>");
      return {
        content: lines.join("\n"),
        isError: false,
        details: { name: skill.name, baseDir: skill.baseDir, truncated: body.truncated },
      };
    },
  };
}

/** Slash-command form: the same body, injected as the user's own message. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const block = [
    `<skill name="${skill.name}" location="${skill.filePath}">`,
    `Relative paths in these instructions resolve against ${skill.baseDir}.`,
    "",
    truncateHead(skill.content).text.trim(),
    "</skill>",
  ].join("\n");
  return additionalInstructions ? `${block}\n\n${additionalInstructions}` : block;
}
