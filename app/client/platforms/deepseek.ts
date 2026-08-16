"use client";

import { ApiPath, DEEPSEEK_BASE_URL, DeepSeek } from "@/app/constant";
import {
  ChatMessageTool,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "@/app/store";
import { streamWithThink } from "@/app/utils/chat";
import { estimateTokenLength } from "@/app/utils/token";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  SpeechOptions,
} from "../api";
import { getClientConfig } from "@/app/config/client";
import {
  getMessageTextContent,
  getMessageTextContentWithoutThinking,
} from "@/app/utils";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";

const DEEPSEEK_DEFAULT_INPUT_TOKEN_BUDGET = 256_000;
const DEEPSEEK_NON_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
const DEEPSEEK_NATIVE_SEARCH_MAX_USES = 3;
const DEEPSEEK_ANTHROPIC_MAX_OUTPUT_TOKENS = 65_536;

const DEEPSEEK_NATIVE_WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: DEEPSEEK_NATIVE_SEARCH_MAX_USES,
};

type DeepSeekRequestPayload = Omit<
  RequestPayload,
  "temperature" | "presence_penalty" | "frequency_penalty" | "top_p"
> &
  Partial<
    Pick<
      RequestPayload,
      "temperature" | "presence_penalty" | "frequency_penalty" | "top_p"
    >
  > & {
    thinking?: { type: "enabled" | "disabled" };
    reasoning_effort?: "high" | "max";
  };

type DeepSeekAnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

type DeepSeekAnthropicRequestPayload = {
  model: string;
  messages: DeepSeekAnthropicMessage[];
  system?: string;
  max_tokens: number;
  stream: boolean;
  tool_choice: { type: "auto" };
  thinking: {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  };
  output_config?: {
    effort: "high" | "max";
  };
  temperature?: number;
  top_p?: number;
};

function normalizeDeepSeekModel(model: string) {
  if (model === "deepseek-chat" || model === "deepseek-reasoner") {
    return "deepseek-v4-flash";
  }
  return model;
}

function isErrorMessage(message: any) {
  return !!message?.isError;
}

function cleanPersistedMessages(messages: any[]) {
  return messages.filter((message, index, allMessages) => {
    if (!message || isErrorMessage(message)) return false;

    const next = allMessages[index + 1];
    if (
      message.role === "user" &&
      next?.role === "assistant" &&
      isErrorMessage(next)
    ) {
      return false;
    }

    return true;
  });
}

function trimMessagesToTokenBudget(messages: any[], tokenBudget: number) {
  const selected: any[] = [];
  let usedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || isErrorMessage(message)) continue;

    const tokenCount = estimateTokenLength(getMessageTextContent(message));

    if (selected.length > 0 && usedTokens + tokenCount > tokenBudget) {
      break;
    }

    selected.push(message);
    usedTokens += tokenCount;

    if (usedTokens >= tokenBudget) break;
  }

  return selected.reverse();
}

function buildAnthropicMessages(messages: ChatOptions["messages"]) {
  const systemParts: string[] = [];
  const anthropicMessages: DeepSeekAnthropicMessage[] = [];

  for (const message of messages) {
    const content = getMessageTextContent(message as any).trim();
    if (!content) continue;

    if (message.role === "system") {
      systemParts.push(content);
      continue;
    }

    const role: "user" | "assistant" =
      message.role === "assistant" ? "assistant" : "user";
    const previous = anthropicMessages.at(-1);

    if (previous?.role === role) {
      previous.content += `\n\n${content}`;
    } else {
      anthropicMessages.push({ role, content });
    }
  }

  if (anthropicMessages[0]?.role === "assistant") {
    anthropicMessages.unshift({ role: "user", content: ";" });
  }

  return {
    system: systemParts.join("\n\n"),
    messages: anthropicMessages,
  };
}

function getDeepSeekAnthropicHeaders() {
  const headers = getHeaders();
  const authorization = headers.Authorization;

  if (authorization) {
    headers["x-api-key"] = authorization.replace(/^Bearer\s+/i, "").trim();
  }

  headers["anthropic-version"] = "2023-06-01";
  return headers;
}

export class DeepSeekApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();
    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.deepseekUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.DeepSeek;
      baseUrl = isApp ? DEEPSEEK_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.DeepSeek)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);
    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    const message = res.choices?.at(0)?.message;
    const reasoning = message?.reasoning_content ?? "";
    const content = message?.content ?? "";

    if (reasoning) {
      const quotedReasoning = String(reasoning)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `${quotedReasoning}\n\n${content}`;
    }

    return content;
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const chatStore = useChatStore.getState();
    const currentSession = chatStore.currentSession();
    const globalModelConfig = useAppConfig.getState().modelConfig;
    const sessionModelConfig = currentSession.mask.modelConfig;

    const modelConfig = {
      ...globalModelConfig,
      ...sessionModelConfig,
      deepseekThinking:
        options.config.deepseekThinking ??
        sessionModelConfig.deepseekThinking ??
        globalModelConfig.deepseekThinking ??
        "off",
      deepseekContextTokens:
        options.config.deepseekContextTokens ??
        sessionModelConfig.deepseekContextTokens ??
        globalModelConfig.deepseekContextTokens ??
        DEEPSEEK_DEFAULT_INPUT_TOKEN_BUDGET,
      model: normalizeDeepSeekModel(options.config.model),
      providerName: options.config.providerName,
    };

    currentSession.mask.modelConfig.sendMemory = globalModelConfig.sendMemory;

    const contextTokenBudget =
      modelConfig.deepseekContextTokens ?? DEEPSEEK_DEFAULT_INPUT_TOKEN_BUDGET;
    const persistedMessages = currentSession.messages ?? [];
    const lastPersistedMessage = persistedMessages.at(-1) as any;

    const isInteractiveTurn =
      lastPersistedMessage?.role === "assistant" &&
      lastPersistedMessage?.streaming === true;

    let sourceMessages: any[] = options.messages as any[];

    if (isInteractiveTurn) {
      const persistedIds = new Set(
        persistedMessages.map((message: any) => message?.id).filter(Boolean),
      );

      const supplementalMessages = (options.messages as any[]).filter(
        (message: any) => !message?.id || !persistedIds.has(message.id),
      );

      const cleanMessages = cleanPersistedMessages(
        persistedMessages.slice(0, -1),
      );

      const supplementalTokenCount = supplementalMessages.reduce(
        (total, message) =>
          total + estimateTokenLength(getMessageTextContent(message)),
        0,
      );

      const historyBudget = Math.max(
        32_000,
        contextTokenBudget - supplementalTokenCount,
      );

      sourceMessages = [
        ...supplementalMessages,
        ...trimMessagesToTokenBudget(cleanMessages, historyBudget),
      ];

      console.log("[DeepSeek Context]", {
        persistedMessages: persistedMessages.length,
        selectedMessages: sourceMessages.length,
        inputTokenBudget: contextTokenBudget,
      });
    }

    const messages: ChatOptions["messages"] = [];
    for (const v of sourceMessages) {
      if (isErrorMessage(v)) continue;

      if (v.role === "assistant") {
        const content = getMessageTextContentWithoutThinking(v);
        messages.push({ role: v.role, content });
      } else {
        const content = getMessageTextContent(v);
        messages.push({ role: v.role, content });
      }
    }

    const filteredMessages: ChatOptions["messages"] = [];
    let hasFoundFirstUser = false;

    for (const msg of messages) {
      if (msg.role === "system") {
        filteredMessages.push(msg);
      } else if (msg.role === "user") {
        filteredMessages.push(msg);
        hasFoundFirstUser = true;
      } else if (hasFoundFirstUser) {
        filteredMessages.push(msg);
      }
    }

    const thinkingLevel = modelConfig.deepseekThinking ?? "off";
    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      // Normal interactive DeepSeek chat always has native web search available.
      // The server tool uses tool_choice:auto, so the model decides whether a
      // search is actually needed. Internal title/summarization calls continue
      // to use Chat Completions and therefore do not trigger unnecessary search.
      if (shouldStream && isInteractiveTurn) {
        const anthropicInput = buildAnthropicMessages(filteredMessages);
        const nativeSearchPayload: DeepSeekAnthropicRequestPayload = {
          model: modelConfig.model,
          messages: anthropicInput.messages,
          system: anthropicInput.system || undefined,
          max_tokens: DEEPSEEK_ANTHROPIC_MAX_OUTPUT_TOKENS,
          stream: true,
          tool_choice: { type: "auto" },
          thinking:
            thinkingLevel === "off"
              ? { type: "disabled" }
              : {
                  type: "enabled",
                  budget_tokens: thinkingLevel === "max" ? 16_384 : 8_192,
                },
          output_config:
            thinkingLevel === "off"
              ? undefined
              : { effort: thinkingLevel === "max" ? "max" : "high" },
          temperature:
            thinkingLevel === "off" ? modelConfig.temperature : undefined,
          top_p: thinkingLevel === "off" ? modelConfig.top_p : undefined,
        };

        const nativeSearchPath = this.path("anthropic/v1/messages");

        console.log("[DeepSeek Native Search Request]", {
          model: nativeSearchPayload.model,
          messageCount: nativeSearchPayload.messages.length,
          contextTokenBudget,
          selectedThinkingLevel: thinkingLevel,
          webSearch: "auto",
          maxSearchUses: DEEPSEEK_NATIVE_SEARCH_MAX_USES,
        });

        return streamWithThink(
          nativeSearchPath,
          nativeSearchPayload,
          getDeepSeekAnthropicHeaders(),
          [DEEPSEEK_NATIVE_WEB_SEARCH_TOOL],
          {},
          controller,
          (text: string) => {
            const json = JSON.parse(text);

            if (json.type === "content_block_start") {
              const block = json.content_block ?? {};

              if (block.type === "server_tool_use") {
                console.log("[DeepSeek Native Web Search]", {
                  name: block.name,
                  input: block.input,
                });
              }

              if (block.type === "thinking" && block.thinking) {
                return {
                  isThinking: true,
                  content: String(block.thinking),
                };
              }

              if (block.type === "text" && block.text) {
                return {
                  isThinking: false,
                  content: String(block.text),
                };
              }
            }

            if (json.type === "content_block_delta") {
              const delta = json.delta ?? {};

              if (delta.type === "thinking_delta" && delta.thinking) {
                return {
                  isThinking: true,
                  content: String(delta.thinking),
                };
              }

              if (delta.type === "text_delta" && delta.text) {
                return {
                  isThinking: false,
                  content: String(delta.text),
                };
              }
            }

            return { isThinking: false, content: "" };
          },
          () => {
            // DeepSeek's web_search is a server-side Anthropic tool. It is
            // executed by DeepSeek and never needs a client-side tool result.
          },
          options,
        );
      }

      const requestPayload: DeepSeekRequestPayload = {
        messages: filteredMessages,
        stream: options.config.stream,
        model: modelConfig.model,
      };

      if (thinkingLevel === "off") {
        requestPayload.thinking = { type: "disabled" };
        requestPayload.temperature = modelConfig.temperature;
        requestPayload.presence_penalty = modelConfig.presence_penalty;
        requestPayload.frequency_penalty = modelConfig.frequency_penalty;
        requestPayload.top_p = modelConfig.top_p;
      } else {
        requestPayload.thinking = { type: "enabled" };
        requestPayload.reasoning_effort =
          thinkingLevel === "max" ? "max" : "high";
      }

      console.log("[DeepSeek ChatCompletions Request]", {
        model: requestPayload.model,
        messageCount: requestPayload.messages?.length ?? 0,
        contextTokenBudget,
        selectedThinkingLevel: thinkingLevel,
        thinking: requestPayload.thinking,
        reasoningEffort: requestPayload.reasoning_effort,
      });

      const chatPath = this.path(DeepSeek.ChatPath);

      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(currentSession.mask?.plugin || []);

        return streamWithThink(
          chatPath,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          (text: string, runTools: ChatMessageTool[]) => {
            const json = JSON.parse(text);

            if (json.type === "response.reasoning_text.delta") {
              return {
                isThinking: true,
                content: json.delta ?? "",
              };
            }
            if (json.type === "response.output_text.delta") {
              return {
                isThinking: false,
                content: json.delta ?? "",
              };
            }

            const choice = json.choices?.[0];
            const delta = choice?.delta ?? {};
            const toolCalls = delta.tool_calls as ChatMessageTool[] | undefined;

            if (toolCalls?.length) {
              for (const toolCall of toolCalls as any[]) {
                const index = toolCall?.index ?? 0;
                const id = toolCall?.id;
                const args = toolCall?.function?.arguments ?? "";

                if (id) {
                  runTools[index] = {
                    id,
                    index,
                    type: toolCall?.type,
                    function: {
                      name: toolCall?.function?.name as string,
                      arguments: args,
                    },
                  };
                } else if (runTools[index]?.function) {
                  runTools[index].function!.arguments =
                    (runTools[index].function!.arguments ?? "") + args;
                }
              }
            }

            const reasoning =
              delta.reasoning_content ??
              delta.reasoning ??
              json.reasoning_content ??
              json.reasoning ??
              null;
            const content = delta.content ?? json.content ?? null;

            if (reasoning) {
              return { isThinking: true, content: String(reasoning) };
            }
            if (content) {
              return { isThinking: false, content: String(content) };
            }
            return { isThinking: false, content: "" };
          },
          (
            payload: DeepSeekRequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            payload.messages?.splice(
              payload.messages.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      }

      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        DEEPSEEK_NON_STREAM_TIMEOUT_MS,
      );

      try {
        const res = await fetch(chatPath, {
          method: "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          headers: getHeaders(),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`DeepSeek API Error ${res.status}: ${errorText}`);
        }

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message, res);
      } finally {
        clearTimeout(requestTimeoutId);
      }
    } catch (e) {
      console.error("[DeepSeek API Error]", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    return { used: 0, total: 0 };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
