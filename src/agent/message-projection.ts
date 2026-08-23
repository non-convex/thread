import type { Message } from "@earendil-works/pi-ai";

function visibleContent(content: Message["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      return {
        type: "image",
        mimeType: block.mimeType,
        note: "binary image data omitted from text-only semantic input",
      };
    }
    if (block.type === "toolCall") {
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments,
        ...(block.namespace ? { namespace: block.namespace } : {}),
      };
    }
    return { type: "thinking", note: "assistant thinking omitted from semantic input" };
  });
}

function absoluteDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function projectSemanticMessage(message: Message): unknown {
  if (message.role === "user") {
    return { role: message.role, date: absoluteDate(message.timestamp), content: visibleContent(message.content) };
  }
  if (message.role === "assistant") {
    return {
      role: message.role,
      date: absoluteDate(message.timestamp),
      content: visibleContent(message.content.filter((block) => block.type !== "thinking")),
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    };
  }
  return {
    role: message.role,
    date: absoluteDate(message.timestamp),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: visibleContent(message.content),
    isError: message.isError,
    ...(message.addedToolNames?.length ? { addedToolNames: message.addedToolNames } : {}),
  };
}

export function semanticMessageTranscript(
  messages: readonly Message[],
  label: string,
  emptyText: string,
): string {
  if (messages.length === 0) return emptyText;
  return messages
    .map(
      (message, index) =>
        `[${label} ${index + 1}/${messages.length}]\n${JSON.stringify(projectSemanticMessage(message))}`,
    )
    .join("\n\n");
}
