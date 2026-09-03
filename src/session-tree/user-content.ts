import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";

export function userContentFrom(
  text: string,
  images: readonly ImageContent[] = [],
): string | (TextContent | ImageContent)[] {
  if (images.length === 0) return text;
  const blocks: (TextContent | ImageContent)[] = images.map((image) => ({
    type: "image",
    mimeType: image.mimeType,
    data: image.data,
  }));
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

export function userContentIsEmpty(text: string, images: readonly ImageContent[] = []): boolean {
  return !text.trim() && images.length === 0;
}

export function isEmptyUserMessageContent(content: UserMessage["content"]): boolean {
  if (typeof content === "string") return !content.trim();
  const hasImage = content.some((block) => block.type === "image");
  const text = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return !hasImage && !text;
}

export function userContentDisplay(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  let images = 0;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "image") images += 1;
  }
  const label = images === 0 ? "" : images === 1 ? "[image]" : `[${images} images]`;
  const text = texts.join("\n").trim();
  if (label && text) return `${label}\n${text}`;
  return text || label;
}

export function messageWithoutImages(message: Message): Message {
  if (typeof message.content === "string" || message.role === "assistant") return message;
  const imageCount = message.content.filter((block) => block.type === "image").length;
  if (imageCount === 0) return message;
  const marker: TextContent = {
    type: "text",
    text: imageCount === 1 ? "[image omitted: current model is text-only]" : `[${imageCount} images omitted: current model is text-only]`,
  };
  const text = message.content.filter((block): block is TextContent => block.type === "text");
  return { ...message, content: [marker, ...text] };
}
