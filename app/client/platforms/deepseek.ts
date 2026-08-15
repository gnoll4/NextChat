"use client";
// azure and openai, using same models. so using same LLMApi.
import { ApiPath, DEEPSEEK_BASE_URL, DeepSeek } from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
} from "@/app/store";
import { streamWithThink } from "@/app/utils/chat";
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
  getTimeoutMSByModel,
} from "@/app/utils";
import { fetch } from "@/app/utils/stream";

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
    return res.choices?.at(0)?.message?.content ?? "";
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const messages: ChatOptions["messages"] = [];
  
    for (const v of options.messages) {
      if (v.role === "assistant") {
        const content = getMessageTextContentWithoutThinking(v);
        messages.push({ role: v.role, content });
      } else {
        const content = getMessageTextContent(v);
        messages.push({ role: v.role, content });
      }
    }
  
    // 确保第一个非 system 消息为 user
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
  
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      model: options.config.model,
      providerName: options.config.providerName,
    };
  
    const thinkingLevel =
      modelConfig.deepseekThinking ?? "high";
  
    const reasoningEffort =
      thinkingLevel === "off"
        ? "none"
        : thinkingLevel;
  
    /*
     * DeepSeek Responses API
     *
     * off  -> none
     * low  -> low
     * high -> high
     * max  -> max
     */
    const requestPayload: any = {
      model: modelConfig.model,
  
      input: filteredMessages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
  
      stream: !!options.config.stream,
  
      reasoning: {
        effort: reasoningEffort,
      },
    };
  
    // 非思考模式下这些参数才真正有效
    if (thinkingLevel === "off") {
      requestPayload.temperature =
        modelConfig.temperature;
  
      requestPayload.top_p =
        modelConfig.top_p;
    }
  
    console.log(
      "[DeepSeek Responses Request]",
      requestPayload,
    );
  
    const controller = new AbortController();
    options.onController?.(controller);
  
    /*
     * DeepSeek 官方原生 Web Search
     *
     * tool_choice 默认 auto：
     * 由模型判断是否需要联网。
     */
    const nativeTools = [
      {
        type: "web_search",
      },
    ];
  
    try {
      const responsePath =
        this.path(DeepSeek.ResponsesPath);
  
      /*
       * 流式
       */
      if (options.config.stream) {
        return streamWithThink(
          responsePath,
  
          requestPayload,
  
          getHeaders(),
  
          nativeTools,
  
          {},
  
          controller,
  
          /*
           * DeepSeek Responses API SSE Parser
           */
          (text: string) => {
            const json = JSON.parse(text);
  
            /*
             * 思考内容
             */
            if (
              json.type ===
              "response.reasoning_text.delta"
            ) {
              return {
                isThinking: true,
                content: json.delta ?? "",
              };
            }
  
            /*
             * 最终回答
             */
            if (
              json.type ===
              "response.output_text.delta"
            ) {
              return {
                isThinking: false,
                content: json.delta ?? "",
              };
            }
  
            /*
             * 以下事件忽略：
             *
             * response.created
             * response.web_search_call.*
             * response.output_item.*
             * response.completed
             */
            return {
              isThinking: false,
              content: "",
            };
          },
  
          /*
           * 原生 web_search 在 DeepSeek 服务端执行，
           * 不需要 NextChat 本地执行 Tool。
           */
          () => {},
  
          options,
        );
      }
  
      /*
       * 非流式
       */
      const res = await fetch(responsePath, {
        method: "POST",
  
        body: JSON.stringify({
          ...requestPayload,
          tools: nativeTools,
        }),
  
        signal: controller.signal,
  
        headers: getHeaders(),
      });
  
      if (!res.ok) {
        const errorText = await res.text();
  
        throw new Error(
          `DeepSeek API Error ${res.status}: ${errorText}`,
        );
      }
  
      const data = await res.json();
  
      const outputText =
        data.output
          ?.filter(
            (item: any) =>
              item.type === "message",
          )
          ?.flatMap(
            (item: any) =>
              item.content ?? [],
          )
          ?.filter(
            (item: any) =>
              item.type === "output_text",
          )
          ?.map(
            (item: any) =>
              item.text ?? "",
          )
          ?.join("") ?? "";
  
      options.onFinish(outputText, res);
    } catch (e) {
      console.error(
        "[DeepSeek Responses API Error]",
        e,
      );
  
      options.onError?.(e as Error);
    }
  }
  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
