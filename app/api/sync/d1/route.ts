import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

const CHUNK_CHAR_SIZE = 400_000;
const MAX_STATE_CHARS = 16_000_000;

let schemaReadyPromise: Promise<void> | null = null;

function getUserId(request: Request) {
  const email = request.headers.get("cf-access-authenticated-user-email");
  if (email) return email.trim().toLowerCase();

  // Cloudflare Access normally injects the email header above. Keep a JWT
  // fallback for deployments where only the Access assertion reaches Worker.
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

function getDb() {
  const { env } = getCloudflareContext();
  const db = (env as any).NEXTCHAT_DB;

  if (!db?.prepare) {
    throw new Error(
      "D1 binding NEXTCHAT_DB is unavailable. Bind your D1 database with variable name NEXTCHAT_DB.",
    );
  }

  return db;
}

async function ensureSchema(db: any) {
  // Avoid running CREATE TABLE on every sync request in the same Worker
  // isolate. If initialization fails, clear the cached promise so a later
  // request can retry.
  if (!schemaReadyPromise) {
    schemaReadyPromise = Promise.all([
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
        schemaReadyPromise = null;
        throw error;
      });
  }

  return schemaReadyPromise;
}

function errorResponse(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function stateResponse(serialized: string, updatedAt: number) {
  // The payload is already serialized JSON. Returning it directly avoids the
  // expensive D1 string -> JSON.parse -> JS object -> JSON.stringify cycle in
  // the Worker, which is especially costly for long code-heavy chats.
  return new Response(serialized, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-NextChat-Updated-At": String(updatedAt || 0),
    },
  });
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return errorResponse("Cloudflare Access identity not found", 401);
  }

  try {
    const db = getDb();
    await ensureSchema(db);

    const meta = await db
      .prepare(
        `SELECT version, updated_at, chunk_count
         FROM nextchat_sync_meta
         WHERE user_id = ?1`,
      )
      .bind(userId)
      .first();

    if (!meta) {
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "X-NextChat-Updated-At": "0",
        },
      });
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
    if (chunks.length !== Number(meta.chunk_count)) {
      return errorResponse("D1 sync state is incomplete", 409);
    }

    const serialized = chunks.map((row: any) => String(row.data ?? "")).join("");
    return stateResponse(serialized, Number(meta.updated_at) || 0);
  } catch (error) {
    console.error("[D1 Sync] GET failed", error);
    return errorResponse(
      error instanceof Error ? error.message : String(error),
      500,
    );
  }
}

export async function POST(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return errorResponse("Cloudflare Access identity not found", 401);
  }

  try {
    // The browser sends the Chat Store as an already serialized JSON string.
    // Keep it opaque in the Worker: do not request.json() and do not stringify
    // it again. This moves the large JSON parsing cost to the browser.
    const serialized = await request.text();
    if (!serialized) {
      return errorResponse("Missing sync state", 400);
    }

    if (serialized.length > MAX_STATE_CHARS) {
      return errorResponse(
        "Chat sync state is too large for automatic D1 sync (16M characters limit)",
        413,
      );
    }

    const chunks: string[] = [];
    for (let i = 0; i < serialized.length; i += CHUNK_CHAR_SIZE) {
      chunks.push(serialized.slice(i, i + CHUNK_CHAR_SIZE));
    }
    if (chunks.length === 0) chunks.push("");

    const db = getDb();
    await ensureSchema(db);

    const version = `${Date.now()}-${crypto.randomUUID()}`;
    const updatedAt = Date.now();

    // Write a new immutable version first. Meta is switched only after every
    // chunk succeeds, so an interrupted upload cannot corrupt the last good
    // copy seen by other browsers.
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

    // Old versions are no longer referenced and can be safely removed after
    // the new meta pointer is committed.
    await db
      .prepare(
        `DELETE FROM nextchat_sync_chunks
         WHERE user_id = ?1 AND version <> ?2`,
      )
      .bind(userId, version)
      .run();

    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "X-NextChat-Updated-At": String(updatedAt),
        "X-NextChat-Chunks": String(chunks.length),
      },
    });
  } catch (error) {
    console.error("[D1 Sync] POST failed", error);
    return errorResponse(
      error instanceof Error ? error.message : String(error),
      500,
    );
  }
}
