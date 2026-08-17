const DEEPSEEK_PROXY_PREFIX = "/api/deepseek";
const D1_SYNC_PATH = "/api/sync/d1";
const DEFAULT_DEEPSEEK_URL = "https://api.deepseek.com";
const DEEPSEEK_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const D1_CHUNK_CHAR_SIZE = 400_000;
const D1_MAX_STATE_CHARS = 8_000_000;
const D1_MAX_CHUNKS = Math.ceil(D1_MAX_STATE_CHARS / D1_CHUNK_CHAR_SIZE);

let d1SchemaReadyPromise: Promise<void> | null = null;

function jsonError(message: string, status = 500) {
  return new Response(JSON.stringify({ error: true, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-NextChat-Edge-API": "dedicated",
    },
  });
}

function hasAccessIdentity(request: Request) {
  return Boolean(
    request.headers.get("cf-access-authenticated-user-email") ||
      request.headers.get("cf-access-jwt-assertion"),
  );
}

async function proxyDeepSeek(request: Request, env: any) {
  // This Worker is routed only on the Access-protected production hostname.
  // Requiring the Access identity prevents the route from becoming a public
  // proxy for the server-side DeepSeek API key if DNS/routing is changed later.
  if (!hasAccessIdentity(request)) {
    return jsonError("Cloudflare Access identity not found", 401);
  }

  const requestUrl = new URL(request.url);
  const upstreamPath =
    requestUrl.pathname.slice(DEEPSEEK_PROXY_PREFIX.length) || "/";

  let baseUrl = String(env.DEEPSEEK_URL || DEFAULT_DEEPSEEK_URL).trim();
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = `https://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/$/, "");

  const apiKey = String(env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    return jsonError("DEEPSEEK_API_KEY is not configured", 500);
  }

  const upstreamUrl = `${baseUrl}${upstreamPath}${requestUrl.search}`;
  const isAnthropicRequest = upstreamPath.startsWith("/anthropic/");
  const headers = new Headers();

  headers.set(
    "Content-Type",
    request.headers.get("content-type") || "application/json",
  );

  const accept = request.headers.get("accept");
  if (accept) headers.set("Accept", accept);

  if (isAnthropicRequest) {
    headers.set("x-api-key", apiKey);
    headers.set(
      "anthropic-version",
      request.headers.get("anthropic-version") || "2023-06-01",
    );
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  let requestBytes = 0;
  let fixedBody: Uint8Array | undefined;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > DEEPSEEK_MAX_REQUEST_BYTES
    ) {
      return jsonError(
        `DeepSeek request body exceeds ${DEEPSEEK_MAX_REQUEST_BYTES} bytes`,
        413,
      );
    }

    try {
      const bodyBuffer = await request.arrayBuffer();
      requestBytes = bodyBuffer.byteLength;
      if (requestBytes > DEEPSEEK_MAX_REQUEST_BYTES) {
        return jsonError(
          `DeepSeek request body exceeds ${DEEPSEEK_MAX_REQUEST_BYTES} bytes`,
          413,
        );
      }
      fixedBody = new Uint8Array(bodyBuffer);
    } catch (error) {
      if (request.signal.aborted) {
        return jsonError("DeepSeek request aborted while reading body", 499);
      }
      console.error("[Dedicated DeepSeek Proxy Body Read]", error);
      return jsonError(
        error instanceof Error ? error.message : String(error),
        400,
      );
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
  };

  if (fixedBody !== undefined) {
    // Cloudflare sets Content-Length automatically for fixed-length bodies such
    // as TypedArray. Using request.body directly here would make the Worker ->
    // DeepSeek request use Chunked-Encoding again.
    init.body = fixedBody;
  }

  console.log("[Dedicated DeepSeek Proxy Request]", {
    upstreamPath,
    requestBytes,
    fixedLength: true,
  });

  try {
    const upstream = await fetch(upstreamUrl, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("www-authenticate");
    responseHeaders.set("X-Accel-Buffering", "no");
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("X-NextChat-Edge-API", "dedicated");
    responseHeaders.set(
      "X-NextChat-DeepSeek-Proxy",
      "fixed-length-dedicated",
    );
    responseHeaders.set(
      "X-NextChat-DeepSeek-Request-Bytes",
      String(requestBytes),
    );

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return jsonError("DeepSeek request aborted", 499);
    }

    console.error("[Dedicated DeepSeek Proxy]", error);
    return jsonError(
      error instanceof Error ? error.message : String(error),
      502,
    );
  }
}

function getD1UserId(request: Request) {
  const email = request.headers.get("cf-access-authenticated-user-email");
  if (email) return email.trim().toLowerCase();

  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return null;

  try {
    const payloadPart = assertion.split(".")[1];
    if (!payloadPart) return null;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded));
    const jwtEmail = payload?.email;
    return typeof jwtEmail === "string"
      ? jwtEmail.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function getD1(env: any) {
  const db = env.NEXTCHAT_DB;
  if (!db?.prepare) {
    throw new Error(
      "D1 binding NEXTCHAT_DB is unavailable. Bind your D1 database with variable name NEXTCHAT_DB.",
    );
  }
  return db;
}

async function ensureD1Schema(db: any) {
  if (!d1SchemaReadyPromise) {
    d1SchemaReadyPromise = Promise.all([
      db
        .prepare(
          `CREATE TABLE IF NOT EXISTS nextchat_sync_meta (
            user_id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            chunk_count INTEGER NOT NULL
          )`,
        )
        .run(),
      db
        .prepare(
          `CREATE TABLE IF NOT EXISTS nextchat_sync_chunks (
            user_id TEXT NOT NULL,
            version TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (user_id, version, chunk_index)
          )`,
        )
        .run(),
    ])
      .then(() => undefined)
      .catch((error) => {
        d1SchemaReadyPromise = null;
        throw error;
      });
  }

  return d1SchemaReadyPromise;
}

function d1Response(
  body: BodyInit | null,
  status: number,
  extraHeaders?: Record<string, string>,
) {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-NextChat-Edge-API": "dedicated",
      "X-NextChat-D1-Proxy": "dedicated",
      ...(extraHeaders ?? {}),
    },
  });
}

async function handleD1Sync(request: Request, env: any) {
  const userId = getD1UserId(request);
  if (!userId) {
    return d1Response(
      JSON.stringify({ error: "Cloudflare Access identity not found" }),
      401,
      { "Content-Type": "application/json; charset=utf-8" },
    );
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return d1Response(null, 405, { Allow: "GET, POST" });
  }

  try {
    const db = getD1(env);
    await ensureD1Schema(db);

    if (request.method === "GET") {
      const meta = await db
        .prepare(
          `SELECT version, updated_at, chunk_count
           FROM nextchat_sync_meta
           WHERE user_id = ?1`,
        )
        .bind(userId)
        .first();

      if (!meta) {
        return d1Response(null, 204, {
          "X-NextChat-Updated-At": "0",
        });
      }

      const chunkCount = Number(meta.chunk_count) || 0;
      if (chunkCount < 0 || chunkCount > D1_MAX_CHUNKS) {
        return d1Response(
          JSON.stringify({
            error: "D1 sync snapshot is too large for automatic restore",
          }),
          413,
          { "Content-Type": "application/json; charset=utf-8" },
        );
      }

      const rows = await db
        .prepare(
          `SELECT chunk_index, data
           FROM nextchat_sync_chunks
           WHERE user_id = ?1 AND version = ?2
           ORDER BY chunk_index ASC`,
        )
        .bind(userId, meta.version)
        .all();

      const chunks = rows?.results ?? [];
      if (chunks.length !== chunkCount) {
        return d1Response(
          JSON.stringify({ error: "D1 sync state is incomplete" }),
          409,
          { "Content-Type": "application/json; charset=utf-8" },
        );
      }

      const serialized = chunks
        .map((row: any) => String(row.data ?? ""))
        .join("");

      return d1Response(serialized, 200, {
        "Content-Type": "application/json; charset=utf-8",
        "X-NextChat-Updated-At": String(Number(meta.updated_at) || 0),
      });
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > D1_MAX_STATE_CHARS * 4) {
      return d1Response(
        JSON.stringify({
          error: "Chat sync state is too large for automatic D1 sync",
        }),
        413,
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }

    const serialized = await request.text();
    if (!serialized) {
      return d1Response(
        JSON.stringify({ error: "Missing sync state" }),
        400,
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }
    if (serialized.length > D1_MAX_STATE_CHARS) {
      return d1Response(
        JSON.stringify({
          error: "Chat sync state is too large for automatic D1 sync (8M characters limit)",
        }),
        413,
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }

    const chunks: string[] = [];
    for (let i = 0; i < serialized.length; i += D1_CHUNK_CHAR_SIZE) {
      chunks.push(serialized.slice(i, i + D1_CHUNK_CHAR_SIZE));
    }
    if (chunks.length === 0) chunks.push("");

    const version = `${Date.now()}-${crypto.randomUUID()}`;
    const updatedAt = Date.now();

    for (let index = 0; index < chunks.length; index += 1) {
      await db
        .prepare(
          `INSERT INTO nextchat_sync_chunks
             (user_id, version, chunk_index, data)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(userId, version, index, chunks[index])
        .run();
    }

    await db
      .prepare(
        `INSERT INTO nextchat_sync_meta
           (user_id, version, updated_at, chunk_count)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id) DO UPDATE SET
           version = excluded.version,
           updated_at = excluded.updated_at,
           chunk_count = excluded.chunk_count`,
      )
      .bind(userId, version, updatedAt, chunks.length)
      .run();

    await db
      .prepare(
        `DELETE FROM nextchat_sync_chunks
         WHERE user_id = ?1 AND version <> ?2`,
      )
      .bind(userId, version)
      .run();

    return d1Response(null, 204, {
      "X-NextChat-Updated-At": String(updatedAt),
      "X-NextChat-Chunks": String(chunks.length),
    });
  } catch (error) {
    console.error("[Dedicated D1 Sync]", error);
    return d1Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      500,
      { "Content-Type": "application/json; charset=utf-8" },
    );
  }
}

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(`${DEEPSEEK_PROXY_PREFIX}/`)) {
      return proxyDeepSeek(request, env);
    }

    if (url.pathname === D1_SYNC_PATH || url.pathname === `${D1_SYNC_PATH}/`) {
      return handleD1Sync(request, env);
    }

    return jsonError("Not found", 404);
  },
};
