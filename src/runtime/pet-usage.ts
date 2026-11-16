// Reads ZCode's per-request usage rows (`model_usage`) for the pet's speed readout. Kept free of
// electron imports so it can be tested outside ZCode. Read-only and brief: every read opens the
// database read-only, runs one indexed query and closes it again, so nothing of Canvas stays open
// on ZCode's file; it never writes and never waits for a lock. A busy or unreadable database only
// means no figure this time; after a failure reads pause for a while instead of retrying each poll.
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageRow, UsageSource } from "../shared/pet-tps.ts";

/** Where ZCode keeps it (adapters storage/session-store/paths.ts), or its ZCODE_SESSION_DB_PATH override. */
export function zcodeUsageDb(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_SESSION_DB_PATH || env.ZCODE_SESSION_DB;
  if (configured) return /^~(?=$|[\\/])/.test(configured) ? join(homedir(), configured.slice(1)) : configured;
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

const COLUMNS = "started_at, first_token_at, completed_at, output_tokens";
// `+query_source` keeps SQLite off the index on that column: it matches almost every row, and
// without it the planner would scan all of them instead of the session's or the newest few.
const TURN = `select ${COLUMNS} from model_usage where session_id = ? and turn_id = ? and +query_source = 'main_turn'`;
const RECENT_LIMIT = 20;
const SESSION_RECENT = `select ${COLUMNS} from model_usage where session_id = ? and +query_source = 'main_turn' and first_token_at is not null order by started_at desc limit ${RECENT_LIMIT}`;
const ANY_RECENT = `select ${COLUMNS} from model_usage where +query_source = 'main_turn' and first_token_at is not null order by started_at desc limit ${RECENT_LIMIT}`;

const PAUSE_MS = 10_000;

type Sqlite = typeof import("node:sqlite");
type Value = string | number | bigint | null | Uint8Array;

const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "bigint" ? Number(value) : null);

function toRow(raw: Record<string, unknown>): UsageRow | null {
  const startedAt = number(raw.started_at);
  if (startedAt === null) return null;
  return { startedAt, firstTokenAt: number(raw.first_token_at), completedAt: number(raw.completed_at), outputTokens: number(raw.output_tokens) ?? 0 };
}

/**
 * `node:sqlite` is loaded on first use, never at import: on an Electron whose Node lacks it the
 * readout is unavailable and everything else carries on.
 */
export function createUsageReader(file: string, now: () => number = Date.now): UsageSource {
  let pausedUntil = 0;
  let pausedBy: unknown = null;

  function query(sql: string, ...params: Value[]): UsageRow[] {
    if (now() < pausedUntil) throw pausedBy;
    try {
      const sqlite = process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined;
      if (!sqlite) throw new Error("node:sqlite is not available in this ZCode");
      const db = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare(sql).all(...params).flatMap((raw) => toRow(raw as Record<string, unknown>) ?? []);
      } finally {
        db.close();
      }
    } catch (error) {
      pausedUntil = now() + PAUSE_MS;
      pausedBy = error;
      throw error;
    }
  }

  return {
    turn: (sessionId, turnId) => query(TURN, sessionId, turnId),
    recent(sessionId) {
      const own = query(SESSION_RECENT, sessionId);
      return own.length ? own : query(ANY_RECENT);
    },
  };
}
