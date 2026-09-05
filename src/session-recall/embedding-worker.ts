import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";
import { EMBEDDING_DIMENSION } from "./model-assets.js";
import type { TextSpan } from "./types.js";

let tokenizer: Tokenizer;
let session: ort.InferenceSession;

function boundary(text: string, offset: number): number {
  return offset > 0 && /^[\uDC00-\uDFFF]$/.test(text[offset] ?? "") ? offset - 1 : offset;
}

function tokenCount(text: string): number {
  return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
}

function split(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  while (start < text.length) {
    // Keep tokenizer work bounded even for a single enormous source paragraph.
    let low = start + 1;
    let high = Math.min(text.length, start + 8_000);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (tokenCount(text.slice(start, boundary(text, middle))) <= 480) low = middle;
      else high = middle - 1;
    }
    let end = boundary(text, low);
    if (end <= start) end = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end - 2);
      if (paragraph > start + (end - start) / 2) end = paragraph + 2;
    }
    spans.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    // An 8,000-character whitespace run may contain fewer than 48 tokens.
    // Repeating that entire span as overlap would otherwise advance one character.
    if (tokenCount(text.slice(start, end)) <= 48) { start = end; continue; }
    low = start + 1;
    high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tokenCount(text.slice(boundary(text, middle), end)) <= 48) high = middle;
      else low = middle + 1;
    }
    start = Math.max(start + 1, boundary(text, low));
  }
  return spans;
}

async function embed(texts: string[], purpose: "query" | "passage"): Promise<Float32Array[]> {
  if (texts.length === 0 || texts.length > 4) throw new Error("Embedding batch must contain 1–4 texts");
  const encoded = texts.map((text) => tokenizer.encode(`${purpose}: ${text}`).ids);
  if (encoded.some((ids) => ids.length > 512)) throw new Error("Embedding text exceeds the model's 512-token limit");
  const width = Math.max(...encoded.map((ids) => ids.length));
  const pad = tokenizer.token_to_id("<pad>");
  if (pad === undefined) throw new Error("Model tokenizer has no padding token");
  const ids = new BigInt64Array(texts.length * width).fill(BigInt(pad));
  const mask = new BigInt64Array(ids.length);
  for (const [row, tokens] of encoded.entries()) {
    for (const [column, token] of tokens.entries()) {
      ids[row * width + column] = BigInt(token);
      mask[row * width + column] = 1n;
    }
  }
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", ids, [texts.length, width]),
    attention_mask: new ort.Tensor("int64", mask, [texts.length, width]),
  };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(ids.length), [texts.length, width]);
  }
  let outputs: Record<string, ort.Tensor> = {};
  try {
    outputs = await session.run(feeds);
    const output = outputs.last_hidden_state ?? outputs[session.outputNames[0]!];
    if (!output || output.type !== "float32" || output.dims[2] !== EMBEDDING_DIMENSION) {
      throw new Error("Unexpected embedding model output");
    }
    const data = output.data as Float32Array;
    const vectors = encoded.map((tokens, row) => {
      const result = new Float32Array(EMBEDDING_DIMENSION);
      for (let token = 0; token < tokens.length; token++) {
        for (let dim = 0; dim < result.length; dim++) {
          result[dim]! += data[(row * width + token) * result.length + dim]! / tokens.length;
        }
      }
      const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
      if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding model returned an invalid vector");
      for (let dim = 0; dim < result.length; dim++) result[dim]! /= norm;
      return result;
    });
    return vectors;
  } finally {
    for (const tensor of Object.values(feeds)) tensor.dispose();
    for (const tensor of Object.values(outputs)) tensor.dispose();
  }
}

process.on("message", async (message: {
  id: number; method: "initialize" | "split" | "embed" | "close";
  directory?: string; text?: string; texts?: string[]; purpose?: "query" | "passage";
}) => {
  try {
    let value: unknown;
    if (message.method === "initialize") {
      const directory = message.directory!;
      tokenizer = new Tokenizer(
        JSON.parse(await readFile(path.join(directory, "tokenizer.json"), "utf8")),
        JSON.parse(await readFile(path.join(directory, "tokenizer_config.json"), "utf8")),
      );
      session = await ort.InferenceSession.create(path.join(directory, "onnx/model_quantized.onnx"), {
        executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1,
      });
    } else if (message.method === "split") value = split(message.text!);
    else if (message.method === "embed") value = await embed(message.texts!, message.purpose!);
    else if (message.method === "close") await session?.release();
    process.send!({ id: message.id, value }, () => {
      if (message.method === "close") process.exit(0);
    });
  } catch (error) {
    process.send!({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
process.on("disconnect", () => process.exit(0));
