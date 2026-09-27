import { createHash } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { TSchema } from "@earendil-works/pi-ai";
import { MAX_IMAGE_BYTES, prepareImageBytes } from "../images/prepare.js";
import { limited } from "../tools/results.js";
import type { AgentTool, ToolContext, ToolResult } from "../tools/types.js";

/** Provider-safe names; routing always uses the original server and tool IDs. */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  if (raw.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(raw) && !server.includes("__") && !tool.includes("__")) return raw;
  const hash = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 12);
  return `${raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 51)}_${hash}`;
}

export function createMcpTool(server: string, definition: Tool,
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>): AgentTool {
  return {
    name: mcpToolName(server, definition.name),
    description: `[MCP server: ${server}; tool: ${definition.name}]\n${definition.description ?? definition.title ?? definition.name}`,
    // Pi's validator accepts plain JSON Schema as well as TypeBox-authored schemas.
    // Do not rewrite required/additionalProperties or discard schema constraints.
    parameters: structuredClone(definition.inputSchema) as TSchema,
    execution: {
      effect: "process",
      resources: () => [{ namespace: "mcp", resource: JSON.stringify([server, definition.name]), access: "write" }],
    },
    async execute(args, context) {
      return convertMcpResult(await call(args, context.signal), context);
    },
  };
}

async function convertMcpResult(result: CallToolResult, context: ToolContext): Promise<ToolResult> {
  const text: string[] = [];
  const images: NonNullable<ToolResult["images"]>[number][] = [];
  let imageBytes = 0;
  const add = (value: string) => { text.push(limited(value)); };
  const structured = result.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent);
  if (structured !== undefined) add(structured);
  for (const block of result.content.slice(0, 128)) {
    context.signal.throwIfAborted();
    switch (block.type) {
      case "text":
        if (block.text !== structured) add(block.text);
        break;
      case "image": {
        if (!context.acceptsImages) { add("[MCP image omitted: current model does not accept images]"); break; }
        if (images.length >= 4 || block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
          add("[MCP image omitted: image limit exceeded]"); break;
        }
        try {
          const image = await prepareImageBytes(Buffer.from(block.data, "base64"), { signal: context.signal });
          const bytes = Buffer.byteLength(image.data, "base64");
          if (imageBytes + bytes > MAX_IMAGE_BYTES) { add("[MCP image omitted: total image limit exceeded]"); break; }
          imageBytes += bytes;
          images.push({ type: "image", data: image.data, mimeType: image.mimeType });
          add(`[MCP image attached: ${image.width} × ${image.height}]`);
        } catch (error) {
          context.signal.throwIfAborted();
          add(`[MCP image omitted: ${error instanceof Error ? error.message : String(error)}]`);
        }
        break;
      }
      case "resource_link":
        add(`[MCP resource: ${block.name}] ${block.uri}${block.description ? `\n${block.description}` : ""}`);
        break;
      case "resource":
        add(`MCP resource: ${block.resource.uri}\n${"text" in block.resource ? block.resource.text : "[Binary resource omitted]"}`);
        break;
      default:
        add(`[Unsupported MCP content omitted: ${block.type}]`);
    }
  }
  if (result.content.length > 128) add("[Additional MCP content blocks omitted]");
  return { content: limited(text.join("\n\n") || "(MCP tool returned no content)"), isError: result.isError === true,
    ...(images.length ? { images } : {}) };
}
