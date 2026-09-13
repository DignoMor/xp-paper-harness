import type { LlmProvider } from "../application/ports.js";
import { FakeLlmProvider } from "./fake-provider.js";
import { createOpenCodeGoProviderFromEnv } from "./opencode-go-provider.js";

export {
  FakeLlmProvider,
  abortError,
  throwIfAborted,
} from "./fake-provider.js";
export type {
  FakeHandler,
  FakeLlmProviderOptions,
  FakeToolCallSpec,
  FakeTurn,
} from "./fake-provider.js";

export {
  OpenCodeGoProvider,
  createOpenCodeGoProviderFromEnv,
  CREDENTIALS_MISSING_MESSAGE,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_SESSION_HEADER,
} from "./opencode-go-provider.js";
export type { OpenCodeGoConfig } from "./opencode-go-provider.js";

export function createLlmProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): LlmProvider {
  if (env.LLM_PROVIDER === "fake") {
    return new FakeLlmProvider();
  }
  return createOpenCodeGoProviderFromEnv(env);
}
