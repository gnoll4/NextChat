import { getCloudflareContext } from "@opennextjs/cloudflare";

export const dynamic = "force-dynamic";

const CHUNK_CHAR_SIZE = 400_000;
const MAX_STATE_CHARS = 20_000_000;

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
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS nextchat_sync_meta (
        user_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL
      )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS nextchat_sync_chunks (
        user_id TEXT NOT NULL,
        version TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (user_id, version, chunk_index)
      )`,
    )
    .run();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return jsonResponse(
      { error: "Cloudflare Access identity not found" },
      401,
    );
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
      return jsonResponse({ state: null, updatedAt: 0 });
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
      return jsonResponse({ error: "D1 sync state is incomplete" }, 409);
    }

    const serialized = chunks.map((row: any) => row.data).join("");
    const state = serialized ? JSON.parse(serialized) : null;

    return jsonResponse({
      state,
      updatedAt: Number(meta.updated_at) || 0,
    });
  } catch (error) {
    console.error("[D1 Sync] GET failed", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}

export async function POST(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return jsonResponse(
      { error: "Cloudflare Access identity not found" },
      401,
    );
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || !("state" in body)) {
      return jsonResponse({ error: "Missing sync state" }, 400);
    }

    const serialized = JSON.stringify(body.state);
    if (serialized.length > MAX_STATE_CHARS) {
      return jsonResponse(
        {
          error:
            "Chat sync state is too large for automatic D1 sync (20M characters limit)",
        },
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

    return jsonResponse({
      ok: true,
      updatedAt,
      chunks: chunks.length,
    });
  } catch (error) {
    console.error("[D1 Sync] POST failed", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
}
