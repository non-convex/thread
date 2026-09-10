import type { AgentTool, ToolContext, ToolResult } from "../../src/core/tools/types.js";

export async function executeTool<A extends Record<string, unknown>, P extends Record<string, unknown>>(
  tool: AgentTool<A, P>, args: A, context: ToolContext,
): Promise<ToolResult> {
  try {
    const prepared = tool.prepare ? await tool.prepare(args, context) : args as unknown as P;
    const resources = await tool.execution.resources(prepared, context);
    return await tool.execute(prepared, { ...context, resources });
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}
