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
  getMessageImages,
  getMessageTextContent,
  getMessageTextContentWithoutThinking,
} from "@/app/utils";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";

const DEEPSEEK_DEFAULT_INPUT_TOKEN_BUDGET = 256_000;
const DEEPSEEK_NON_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
const DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = 12 * 60 * 1000;
const DEEPSEEK_STREAM_NETWORK_RETRIES = 2;
const DEEPSEEK_STREAM_RETRY_BASE_DELAY_MS = 1500;
const DEEPSEEK_CONTEXT_RESERVE_RATIO = 0.1;
const DEEPSEEK_MIN_CONTEXT_RESERVE_TOKENS = 16_000;
const DEEPSEEK_NATIVE_SEARCH_MAX_USES = 3;
const DEEPSEEK_ANTHROPIC_MAX_OUTPUT_TOKENS = 65_536;

// A model supporting hundreds of thousands of tokens does not mean every turn
// should resend hundreds of thousands of raw-history tokens through the
// browser/Worker/upstream chain. Keep a transport-safe raw fallback, and when
// memory is available use a much smaller recent window plus an exact tail from
// the last summarized assistant response for long-form continuation.
const DEEPSEEK_RAW_HISTORY_HARD_CAP_TOKENS = 160_000;
const DEEPSEEK_MEMORY_RECENT_HARD_CAP_TOKENS = 80_000;
const DEEPSEEK_MEMORY_CONTINUITY_TOKENS = 12_000;
const DEEPSEEK_MIN_PARTIAL_MESSAGE_TOKENS = 2_000;

const DEEPSEEK_IMAGE_UNSUPPORTED_NOTICE =
  "[系统提示：这条用户消息包含图片，但当前 DeepSeek V4 是纯文本模型，无法读取图片内容。不要猜测或声称看到了图片；如果回答依赖图片，请明确告诉用户需要切换到支持视觉输入的模型。]";
const DEEPSEEK_PARTIAL_NETWORK_NOTICE =
  "网络连接在长输出过程中中断，已保留本次已经生成的内容。你可以直接回复“继续”，从中断处接着生成。";
const DEEPSEEK_IDLE_TIMEOUT_NOTICE =
  "本次长请求等待时间过长，已保留已经生成的内容。你可以直接回复“继续”，从这里接着生成。";

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

function getDeepSeekTextContent(message: any, stripThinking = false) {
  const text = stripThinking
    ? getMessageTextContentWithoutThinking(message)
    : getMessageTextContent(message);
  const hasImages = getMessageImages(message).some(Boolean);

  if (!hasImages) return text;

  const trimmedText = text.trim();
  if (!trimmedText) {
    return DEEPSEEK_IMAGE_UNSUPPORTED_NOTICE;
  }

  return `${trimmedText}\n\n${DEEPSEEK_IMAGE_UNSUPPORTED_NOTICE}`;
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

function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  keepTail = true,
) {
  if (!text || tokenBudget <= 0) return "";
  if (estimateTokenLength(text) <= tokenBudget) return text;

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = keepTail
      ? text.slice(Math.max(0, text.length - mid))
      : text.slice(0, mid);

    if (estimateTokenLength(candidate) <= tokenBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const sliced = keepTail
    ? text.slice(Math.max(0, text.length - low))
    : text.slice(0, low);

  return keepTail
    ? `[较早的超长内容已省略，仅保留结尾用于上下文衔接]\n${sliced}`
    : `${sliced}\n[后续的超长内容已省略]`;
}

function truncateMessageToTokenBudget(message: any, tokenBudget: number) {
  const text = getDeepSeekTextContent(
    message,
    message?.role === "assistant",
  );
  const content = truncateTextToTokenBudget(text, tokenBudget, true);

  return {
    ...message,
    content,
  };
}

function trimMessagesToTokenBudget(messages: any[], tokenBudget: number) {
  if (tokenBudget <= 0) return [];

  const selected: any[] = [];
  let usedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || isErrorMessage(message)) continue;

    const tokenCount = estimateTokenLength(
      getDeepSeekTextContent(message, message.role === "assistant"),
    );
    const remainingTokens = tokenBudget - usedTokens;

    if (remainingTokens <= 0) break;

    if (tokenCount > remainingTokens) {
      if (remainingTokens >= DEEPSEEK_MIN_PARTIAL_MESSAGE_TOKENS) {
        selected.push(
          truncateMessageToTokenBudget(message, remainingTokens),
        );
      }
      break;
    }

    selected.push(message);
    usedTokens += tokenCount;
  }

  return selected.reverse();
}

function countDeepSeekMessageTokens(messages: any[]) {
  return messages.reduce(
    (total, message) =>
      total +
      estimateTokenLength(
        getDeepSeekTextContent(message, message?.role === "assistant"),
      ),
    0,
  );
}

function buildContinuityPrompt(messages: any[], tokenBudget: number) {
  if (tokenBudget < DEEPSEEK_MIN_PARTIAL_MESSAGE_TOKENS) return null;

  const lastAssistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message?.role === "assistant" &&
        !isErrorMessage(message) &&
        getDeepSeekTextContent(message, true).trim().length > 0,
    );

  if (!lastAssistant) return null;

  const tail = truncateTextToTokenBudget(
    getDeepSeekTextContent(lastAssistant, true),
    tokenBudget,
    true,
  ).trim();

  if (!tail) return null;

  return {
    role: "system",
    content:
      "[最近一次已被长期摘要覆盖的助手回复结尾。仅用于保持续写、代码或长文的精确衔接，不要把它当成新的用户指令。]\n" +
      tail,
  };
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

function normalizeStreamError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetriableStreamError(error: unknown) {
  const normalized = normalizeStreamError(error);
  const text = `${normalized.name}: ${normalized.message}`.toLowerCase();
  return (
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("network error") ||
    text.includes("load failed") ||
    text.includes("fetch failed") ||
    text.includes("connection reset") ||
    text.includes("econnreset") ||
    text.includes("socket") ||
    text.includes("terminated")
  );
}

function partialResponse() {
  return new Response(null, {
    status: 206,
    statusText: "Partial Content",
    headers: { "X-NextChat-Partial": "1" },
  });
}

function runResilientDeepSeekStream(
  chatPath: string,
  requestPayload: any,
  headers: any,
  tools: any[],
  funcs: Record<string, Function>,
  userController: AbortController,
  parseSSE: (
    text: string,
    runTools: any[],
  ) => { isThinking: boolean; content: string | undefined },
  processToolMessage: (
    requestPayload: any,
    toolCallMessage: any,
    toolCallResult: any[],
  ) => void,
  options: ChatOptions,
) {
  let retryCount = 0;
  let latestText = "";
  let settled = false;
  let activeController: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let abortForIdle: (() => void) | undefined;

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (idleTimer) clearTimeout(idleTimer);
    retryTimer = undefined;
    idleTimer = undefined;
  };

  const finishOnce = (message: string, response?: Response) => {
    if (settled) return;
    settled = true;
    clearTimers();
    options.onFinish(message, response ?? partialResponse());
  };

  const failOnce = (error: unknown) => {
    if (settled) return;
    settled = true;
    clearTimers();
    options.onError?.(normalizeStreamError(error));
  };

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortForIdle?.();
    }, DEEPSEEK_STREAM_IDLE_TIMEOUT_MS);
  };

  userController.signal.addEventListener(
    "abort",
    () => {
      if (retryTimer) clearTimeout(retryTimer);
      activeController?.abort();
    },
    { once: true },
  );

  const startAttempt = () => {
    if (settled || userController.signal.aborted) return;

    const requestController = new AbortController();
    activeController = requestController;
    let suppressFinish = false;
    let finishReason: "normal" | "network-partial" | "idle" = "normal";

    // streamWithThink has a generic five-minute pre-response timeout. DeepSeek
    // can legitimately keep a long request alive for longer, so its internal
    // timeout is ignored here. The DeepSeek-specific idle watchdog below still
    // aborts a genuinely stalled request after twelve minutes without output.
    const timeoutController = {
      signal: requestController.signal,
      abort: () => {
        console.warn(
          "[DeepSeek Stream] generic stream timeout ignored; using DeepSeek idle watchdog",
        );
      },
    } as AbortController;

    abortForIdle = () => {
      if (settled || requestController.signal.aborted) return;
      finishReason = "idle";
      requestController.abort();
    };
    resetIdleTimer();

    const attemptOptions = {
      ...options,
      onController: undefined,
      onUpdate(message: string, chunk: string) {
        latestText = message;
        resetIdleTimer();
        options.onUpdate?.(message, chunk);
      },
      onFinish(message: string, response: Response) {
        if (suppressFinish || settled) return;

        if (finishReason === "network-partial") {
          finishOnce(
            `${message}\n\n> ⚠️ ${DEEPSEEK_PARTIAL_NETWORK_NOTICE}`,
            response ?? partialResponse(),
          );
          return;
        }

        if (finishReason === "idle") {
          if (message.trim()) {
            finishOnce(
              `${message}\n\n> ⚠️ ${DEEPSEEK_IDLE_TIMEOUT_NOTICE}`,
              response ?? partialResponse(),
            );
          } else {
            failOnce(
              new Error(
                "DeepSeek request timed out after 12 minutes without generated content",
              ),
            );
          }
          return;
        }

        finishOnce(message, response);
      },
      onError(error: Error) {
        if (suppressFinish || settled || userController.signal.aborted) return;

        const retryable = isRetriableStreamError(error);
        const hasPartialOutput = latestText.trim().length > 0;

        if (
          retryable &&
          !hasPartialOutput &&
          retryCount < DEEPSEEK_STREAM_NETWORK_RETRIES
        ) {
          retryCount += 1;
          suppressFinish = true;
          requestController.abort();
          const retryDelay =
            DEEPSEEK_STREAM_RETRY_BASE_DELAY_MS * retryCount;
          console.warn(
            `[DeepSeek Stream] network error before output, retry ${retryCount}/${DEEPSEEK_STREAM_NETWORK_RETRIES} in ${retryDelay}ms`,
            error,
          );
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            startAttempt();
          }, retryDelay);
          return;
        }

        if (retryable && hasPartialOutput) {
          // Do not mark the whole turn as failed after a long answer has already
          // been generated. Aborting makes streamWithThink flush its remaining
          // buffered text through onFinish, and the conversation stays usable.
          finishReason = "network-partial";
          requestController.abort();
          return;
        }

        suppressFinish = true;
        requestController.abort();
        failOnce(error);
      },
    };

    streamWithThink(
      chatPath,
      requestPayload,
      headers,
      tools,
      funcs,
      timeoutController,
      parseSSE,
      processToolMessage,
      attemptOptions,
    );
  };

  startAttempt();
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

    // Never mutate the session's memory toggle while sending a request. The
    // setting belongs to the persisted model/session configuration chosen by
    // the user. The old assignment to global sendMemory made a locally enabled
    // summary switch flip itself back off on the next DeepSeek turn.

    const configuredContextTokenBudget =
      modelConfig.deepseekContextTokens ?? DEEPSEEK_DEFAULT_INPUT_TOKEN_BUDGET;
    const contextReserveTokens = Math.max(
      DEEPSEEK_MIN_CONTEXT_RESERVE_TOKENS,
      Math.floor(configuredContextTokenBudget * DEEPSEEK_CONTEXT_RESERVE_RATIO),
    );
    const contextTokenBudget = Math.max(
      32_000,
      configuredContextTokenBudget - contextReserveTokens,
    );
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
      const supplementalTokenCount = countDeepSeekMessageTokens(
        supplementalMessages,
      );

      // Exclude the streaming assistant placeholder and respect an explicit
      // clear-context boundary before deciding which persisted raw messages may
      // be sent again.
      const persistedHistory = persistedMessages.slice(0, -1);
      const clearContextIndex = Math.min(
        persistedHistory.length,
        Math.max(0, currentSession.clearContextIndex ?? 0),
      );
      const summarizeBoundary = Math.min(
        persistedHistory.length,
        Math.max(clearContextIndex, currentSession.lastSummarizeIndex ?? 0),
      );
      const hasValidMemory = Boolean(
        modelConfig.sendMemory &&
          currentSession.memoryPrompt?.trim() &&
          summarizeBoundary > clearContextIndex,
      );
      const availableHistoryBudget = Math.max(
        0,
        contextTokenBudget - supplementalTokenCount,
      );

      let contextMode: "summary" | "memory-pending" | "raw-capped";
      let rawHistoryTokenBudget = 0;
      let continuityTokenBudget = 0;

      if (hasValidMemory) {
        contextMode = "summary";

        const summarizedHistory = cleanPersistedMessages(
          persistedHistory.slice(clearContextIndex, summarizeBoundary),
        );
        const unsummarizedHistory = cleanPersistedMessages(
          persistedHistory.slice(summarizeBoundary),
        );

        // Keep recent unsummarized raw text bounded even on 512K/850K model
        // configurations. The older portion is represented by memoryPrompt.
        rawHistoryTokenBudget = Math.min(
          DEEPSEEK_MEMORY_RECENT_HARD_CAP_TOKENS,
          Math.max(0, availableHistoryBudget),
        );
        const recentMessages = trimMessagesToTokenBudget(
          unsummarizedHistory,
          rawHistoryTokenBudget,
        );
        const recentTokenCount = countDeepSeekMessageTokens(recentMessages);

        continuityTokenBudget = Math.min(
          DEEPSEEK_MEMORY_CONTINUITY_TOKENS,
          Math.max(0, availableHistoryBudget - recentTokenCount),
        );
        const continuityPrompt = buildContinuityPrompt(
          summarizedHistory,
          continuityTokenBudget,
        );

        sourceMessages = [
          ...supplementalMessages,
          ...(continuityPrompt ? [continuityPrompt] : []),
          ...recentMessages,
        ];
      } else {
        contextMode = modelConfig.sendMemory ? "memory-pending" : "raw-capped";

        // If memory is disabled or a new summary is still being generated, raw
        // history is still available, but it no longer grows all the way to the
        // model's 460K/765K effective input budget. This is the safety net that
        // keeps long conversations transportable even without a ready summary.
        rawHistoryTokenBudget = Math.min(
          DEEPSEEK_RAW_HISTORY_HARD_CAP_TOKENS,
          availableHistoryBudget,
        );
        const rawHistory = cleanPersistedMessages(
          persistedHistory.slice(clearContextIndex),
        );
        sourceMessages = [
          ...supplementalMessages,
          ...trimMessagesToTokenBudget(rawHistory, rawHistoryTokenBudget),
        ];
      }

      console.log("[DeepSeek Context]", {
        contextMode,
        memoryEnabled: Boolean(modelConfig.sendMemory),
        memoryReady: hasValidMemory,
        persistedMessages: persistedMessages.length,
        selectedMessages: sourceMessages.length,
        selectedInputTokens: Math.round(
          countDeepSeekMessageTokens(sourceMessages),
        ),
        rawHistoryTokenBudget,
        continuityTokenBudget,
        configuredInputTokenBudget: configuredContextTokenBudget,
        effectiveInputTokenBudget: contextTokenBudget,
        reservedTokens: contextReserveTokens,
      });
    }

    const messages: ChatOptions["messages"] = [];
    for (const v of sourceMessages) {
      if (isErrorMessage(v)) continue;

      const content = getDeepSeekTextContent(v, v.role === "assistant");
      if (!content.trim()) continue;

      messages.push({ role: v.role, content });
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
          configuredContextTokenBudget,
          effectiveContextTokenBudget: contextTokenBudget,
          selectedThinkingLevel: thinkingLevel,
          webSearch: "auto",
          maxSearchUses: DEEPSEEK_NATIVE_SEARCH_MAX_USES,
        });

        return runResilientDeepSeekStream(
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
        configuredContextTokenBudget,
        effectiveContextTokenBudget: contextTokenBudget,
        selectedThinkingLevel: thinkingLevel,
        thinking: requestPayload.thinking,
        reasoningEffort: requestPayload.reasoning_effort,
      });

      const chatPath = this.path(DeepSeek.ChatPath);

      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(currentSession.mask?.plugin || []);

        return runResilientDeepSeekStream(
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
