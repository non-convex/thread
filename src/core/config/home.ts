import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_THREAD_HOME_NAME = ".thread";

export function getThreadHome(): string {
  const configured = process.env.THREAD_HOME;
  return configured ? path.resolve(configured) : path.join(homedir(), DEFAULT_THREAD_HOME_NAME);
}
