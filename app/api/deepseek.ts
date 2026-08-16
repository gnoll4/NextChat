import { getServerSideConfig } from "@/app/config/server";
import {
  DEEPSEEK_BASE_URL,
  ApiPath,
  ModelProvider,
  ServiceProvider,
} from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { isModelNotavailableInServer } from "@/app/utils/model";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[DeepSeek Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.DeepSeek);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const response = await request(req);
    return response;
  } catch (e) {
    console.error("[DeepSeek] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

async function request(req: NextRequest) {
  const controller = new AbortController();

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.DeepSeek, "");

  let baseUrl = serverConfig.deepseekUrl || DEEPSEEK_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  const fetchUrl = `${baseUrl}${path}`;
  const incomingAuthorization = req.headers.get("Authorization") ?? "";
  const incomingApiKey = req.headers.get("x-api-key") ?? "";
  const serverApiKey = serverConfig.deepseekApiKey ?? "";
  const resolvedApiKey =
    incomingApiKey ||
    incomingAuthorization.replace(/^Bearer\s+/i, "").trim() ||
    serverApiKey;
  const isAnthropicRequest = path.startsWith("/anthropic/");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (isAnthropicRequest) {
    headers["x-api-key"] = resolvedApiKey;
    headers["anthropic-version"] =
      req.headers.get("anthropic-version") || "2023-06-01";
  } else {
    headers.Authorization = resolvedApiKey
      ? `Bearer ${resolvedApiKey}`
      : incomingAuthorization;
  }

  const fetchOptions: RequestInit = {
    headers,
    method: req.method,
    body: req.body,
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  if (serverConfig.customModels && req.body) {
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      if (
        isModelNotavailableInServer(
          serverConfig.customModels,
          jsonBody?.model as string,
          ServiceProvider.DeepSeek as string,
        )
      ) {
        return NextResponse.json(
          {
            error: true,
            message: `you are not allowed to use ${jsonBody?.model} model`,
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error(`[DeepSeek] filter`, e);
    }
  }
  try {
    const res = await fetch(fetchUrl, fetchOptions);

    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
