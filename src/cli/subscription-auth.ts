import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { PiModelCatalog } from "../agent/model-client.js";

function openExternalUrl(url: string): void {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is still printed below so login remains usable without an opener.
  }
}

function writeAuthEvent(event: AuthEvent): void {
  if (event.type === "auth_url") {
    output.write(`Open this URL in your browser:\n${event.url}\n`);
    openExternalUrl(event.url);
    if (event.instructions) output.write(`${event.instructions}\n`);
    return;
  }
  if (event.type === "device_code") {
    output.write(`Open this URL in your browser:\n${event.verificationUri}\nEnter code: ${event.userCode}\n`);
    openExternalUrl(event.verificationUri);
    return;
  }
  output.write(`${event.message}\n`);
  if (event.type === "info") {
    for (const link of event.links ?? []) output.write(`${link.label ?? "More information"}: ${link.url}\n`);
  }
}

export async function loginProvider(catalog: PiModelCatalog, providerId: string): Promise<void> {
  if (!input.isTTY || !output.isTTY) throw new Error("Login requires an interactive terminal");
  const readline = createInterface({ input, output, terminal: true });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException("Login cancelled", "AbortError"));
  process.once("SIGINT", interrupt);
  try {
    await catalog.login(providerId, {
      signal: controller.signal,
      notify: writeAuthEvent,
      prompt: async (prompt) => answerPrompt(readline, prompt, controller.signal),
    });
    output.write(`Logged in to ${providerId}.\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    readline.close();
  }
}

async function answerPrompt(
  readline: ReturnType<typeof createInterface>,
  prompt: AuthPrompt,
  loginSignal: AbortSignal,
): Promise<string> {
  const signal = prompt.signal ? AbortSignal.any([loginSignal, prompt.signal]) : loginSignal;
  if (prompt.type === "select") {
    output.write(`${prompt.message}\n`);
    prompt.options.forEach((option, index) => {
      output.write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`);
    });
    const answer = (await readline.question(`Select [1]: `, { signal })).trim();
    const index = answer ? Number.parseInt(answer, 10) - 1 : 0;
    const selected = prompt.options[index];
    if (!selected) throw new Error("Invalid login selection");
    return selected.id;
  }
  if (prompt.type === "secret") {
    throw new Error("This login flow requested a secret prompt that Thread cannot display safely");
  }
  const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
  return readline.question(`${prompt.message}${suffix}\n> `, { signal });
}

export async function logoutProvider(catalog: PiModelCatalog, providerId: string): Promise<void> {
  await catalog.logout(providerId);
  output.write(`Logged out from ${providerId}.\n`);
}

export async function showAuthStatus(catalog: PiModelCatalog): Promise<void> {
  const statuses = await catalog.authStatus();
  for (const status of statuses) {
    const state = status.authenticated
      ? "logged in (OAuth)"
      : status.credentialType === "api_key"
        ? "configured with API key"
        : "logged out";
    output.write(`${status.providerId}: ${state}\n`);
  }
}
