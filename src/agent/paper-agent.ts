import type { LlmMessage, LlmProvider, LlmToolCall } from "../application/ports.js";
import type {
  ConversationMessage,
  ConversationMeta,
  ConversationStore,
} from "../conversations/conversation-store.js";
import { DEFAULT_CONVERSATION_TITLE } from "../conversations/conversation-store.js";
import { buildSystemPrompt, assertApprovedToolNames } from "./system-prompt.js";
import { createPaperTools, executeTool, type AgentTool, type AgentToolContext } from "./tools.js";

export type AgentEvent =
  | { type: "conversation"; conversation: ConversationMeta }
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; ok: boolean; result: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done"; conversation_id: string; title: string };

export interface PaperAgentDeps {
  provider: LlmProvider;
  conversations: ConversationStore;
  services: AgentToolContext;
  model?: string;
  maxToolIterations?: number;
  systemPromptExtra?: string;
}

export interface RunAgentInput {
  prompt: string;
  conversation_id?: string;
  signal?: AbortSignal;
}

export class PaperAgent {
  readonly tools: AgentTool[];
  private readonly model: string;
  private readonly maxToolIterations: number;

  constructor(private readonly deps: PaperAgentDeps) {
    this.tools = createPaperTools();
    assertApprovedToolNames(this.tools.map((tool) => tool.name));
    this.model = deps.model ?? deps.provider.defaultModel;
    this.maxToolIterations = deps.maxToolIterations ?? 8;
  }

  async *run(input: RunAgentInput): AsyncIterable<AgentEvent> {
    if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
      yield { type: "error", code: "INVALID_INPUT", message: "A prompt is required." };
      return;
    }
    let conversation: ConversationMeta;
    if (input.conversation_id) {
      const existing = await this.deps.conversations.get(input.conversation_id);
      conversation = existing.meta;
    } else {
      const created = await this.deps.conversations.create(
        this.deps.conversations.defaultTitleFromPrompt(input.prompt),
      );
      conversation = created.meta;
    }

    if (conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const prior = await this.deps.conversations.history(conversation.conversation_id);
      const isFirstUserMessage = !prior.some((message) => message.role === "user");
      if (isFirstUserMessage) {
        conversation = await this.deps.conversations.rename(
          conversation.conversation_id,
          this.deps.conversations.defaultTitleFromPrompt(input.prompt),
        );
      }
    }

    yield { type: "conversation", conversation };

    await this.deps.conversations.appendMessage(conversation.conversation_id, {
      role: "user",
      content: input.prompt,
      created_at: new Date().toISOString(),
    });

    const history = await this.deps.conversations.history(conversation.conversation_id);
    const messages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(this.deps.systemPromptExtra) },
      ...history.map(toLlmMessage),
    ];
    const toolSpecs = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    let iterations = 0;
    while (true) {
      if (iterations >= this.maxToolIterations) {
        yield {
          type: "error",
          code: "TOOL_LOOP_LIMIT",
          message: "The agent reached the tool iteration limit.",
        };
        break;
      }
      iterations += 1;

      let assistantText = "";
      const toolCalls: LlmToolCall[] = [];
      let finishReason = "stop";
      let providerFailed = false;

      for await (const event of this.deps.provider.stream({
        model: this.model,
        session_id: conversation.conversation_id,
        messages,
        tools: toolSpecs,
        signal: input.signal,
      })) {
        if (event.type === "text") {
          assistantText += event.delta;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool_call") {
          toolCalls.push(event.call);
          yield { type: "tool_call", name: event.call.name, arguments: event.call.arguments };
        } else if (event.type === "error") {
          providerFailed = true;
          yield { type: "error", code: event.code, message: event.message };
        } else if (event.type === "done") {
          finishReason = event.finish_reason;
        }
      }

      if (providerFailed) {
        await this.appendAssistant(conversation.conversation_id, assistantText, toolCalls);
        yield { type: "done", conversation_id: conversation.conversation_id, title: conversation.title };
        return;
      }

      await this.appendAssistant(conversation.conversation_id, assistantText, toolCalls);
      if (assistantText !== "" || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: assistantText,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }

      if (toolCalls.length === 0) {
        void finishReason;
        break;
      }

      for (const call of toolCalls) {
        const outcome = await executeTool(
          this.tools,
          call.name,
          call.arguments,
          this.deps.services,
        );
        const content = outcome.ok
          ? JSON.stringify(outcome.result)
          : `Error: ${JSON.stringify(outcome.error.toJSON())}`;
        yield {
          type: "tool_result",
          name: call.name,
          ok: outcome.ok,
          result: outcome.ok ? outcome.result : outcome.error.toJSON(),
        };
        const toolMessage: ConversationMessage = {
          role: "tool",
          content,
          created_at: new Date().toISOString(),
          tool_call_id: call.id,
          name: call.name,
        };
        await this.deps.conversations.appendMessage(conversation.conversation_id, toolMessage);
        messages.push(toLlmMessage(toolMessage));
      }
    }

    yield { type: "done", conversation_id: conversation.conversation_id, title: conversation.title };
  }

  private async appendAssistant(
    conversationId: string,
    content: string,
    toolCalls: LlmToolCall[],
  ): Promise<void> {
    if (content === "" && toolCalls.length === 0) return;
    await this.deps.conversations.appendMessage(conversationId, {
      role: "assistant",
      content,
      created_at: new Date().toISOString(),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
}

function toLlmMessage(message: ConversationMessage): LlmMessage {
  const out: LlmMessage = { role: message.role, content: message.content };
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.name) out.name = message.name;
  if (message.tool_calls) out.tool_calls = message.tool_calls;
  return out;
}
