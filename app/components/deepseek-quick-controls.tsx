"use client";

import { useEffect } from "react";
import { ServiceProvider } from "../constant";
import { ModelConfig, useAppConfig } from "../store/config";
import { useChatStore } from "../store/chat";

const selectStyle = {
  height: 30,
  padding: "0 28px 0 10px",
  borderRadius: 8,
  border: "var(--border-in-light)",
  background: "var(--white)",
  color: "var(--black)",
  fontSize: 12,
  outline: "none",
} as const;

export function DeepSeekQuickControls() {
  const config = useAppConfig();
  const chatStore = useChatStore();
  const session = chatStore.currentSession();

  const thinking =
    session?.mask.modelConfig.deepseekThinking ??
    config.modelConfig.deepseekThinking ??
    "off";
  const contextTokens =
    session?.mask.modelConfig.deepseekContextTokens ??
    config.modelConfig.deepseekContextTokens ??
    256000;

  // Sessions that still follow global configuration should also move from the
  // old OpenAI default to the new DeepSeek default after the config migration.
  useEffect(() => {
    if (!session?.mask.syncGlobalConfig) return;
    if (config.modelConfig.providerName !== ServiceProvider.DeepSeek) return;

    const sessionConfig = session.mask.modelConfig;
    if (
      sessionConfig.model === config.modelConfig.model &&
      sessionConfig.providerName === config.modelConfig.providerName &&
      sessionConfig.compressModel === config.modelConfig.compressModel &&
      sessionConfig.compressProviderName ===
        config.modelConfig.compressProviderName
    ) {
      return;
    }

    chatStore.updateTargetSession(session, (targetSession) => {
      targetSession.mask.modelConfig.model = config.modelConfig.model;
      targetSession.mask.modelConfig.providerName =
        config.modelConfig.providerName;
      targetSession.mask.modelConfig.compressModel =
        config.modelConfig.compressModel;
      targetSession.mask.modelConfig.compressProviderName =
        config.modelConfig.compressProviderName;
      targetSession.mask.modelConfig.deepseekThinking =
        config.modelConfig.deepseekThinking;
      targetSession.mask.modelConfig.deepseekContextTokens =
        config.modelConfig.deepseekContextTokens;
    });
  }, [
    chatStore,
    config.modelConfig.compressModel,
    config.modelConfig.compressProviderName,
    config.modelConfig.deepseekContextTokens,
    config.modelConfig.deepseekThinking,
    config.modelConfig.model,
    config.modelConfig.providerName,
    session,
  ]);

  const updateDeepSeekConfig = (
    patch: Partial<
      Pick<ModelConfig, "deepseekThinking" | "deepseekContextTokens">
    >,
  ) => {
    config.update((state) => {
      Object.assign(state.modelConfig, patch);
    });

    const currentSession = chatStore.currentSession();
    if (!currentSession) return;
    chatStore.updateTargetSession(currentSession, (targetSession) => {
      Object.assign(targetSession.mask.modelConfig, patch);
    });
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        minHeight: 46,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "7px 14px",
        boxSizing: "border-box",
        borderBottom: "var(--border-in-light)",
        background: "var(--white)",
        color: "var(--black)",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
        DeepSeek
      </span>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
      >
        推理
        <select
          aria-label="DeepSeek 推理深度"
          value={thinking}
          style={selectStyle}
          onChange={(e) =>
            updateDeepSeekConfig({
              deepseekThinking: e.currentTarget
                .value as ModelConfig["deepseekThinking"],
            })
          }
        >
          <option value="off">关闭</option>
          <option value="high">High</option>
          <option value="max">Max</option>
        </select>
      </label>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
      >
        上下文
        <select
          aria-label="DeepSeek 上下文长度"
          value={String(contextTokens)}
          style={selectStyle}
          onChange={(e) =>
            updateDeepSeekConfig({
              deepseekContextTokens: Number(
                e.currentTarget.value,
              ) as ModelConfig["deepseekContextTokens"],
            })
          }
        >
          <option value="128000">128K</option>
          <option value="256000">256K</option>
          <option value="512000">512K</option>
          <option value="850000">850K</option>
        </select>
      </label>

      <span
        style={{
          marginLeft: "auto",
          fontSize: 11,
          opacity: 0.55,
          whiteSpace: "nowrap",
        }}
      >
        默认联网：模型自动判断
      </span>
    </div>
  );
}
