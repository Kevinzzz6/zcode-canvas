// The pet's speed readout: output tokens per second of a main session's current turn. Pure, no
// node or DOM imports: tested against recorded log lines and usage rows. Two inputs, both ZCode
// internals (docs/design.md §3):
//
// - ZCode's JSONL event log, the one pet-state.ts follows: when a main session's turn starts and
//   ends, when each of its model requests finishes, and when each request's first token came.
// - ZCode's usage table `model_usage` (runtime/pet-usage.ts): one row per model request, written
//   as the request finishes, with its exact output token count.
//
// Nothing is exposed while a response streams (the log redacts token counts, and the stream goes
// from ZCode's host process straight to its page), so while the turn runs the figure is an
// estimate: the pace of the turn's requests finished so far or, before the first one finishes,
// the session's recent pace. Once the turn ends all its rows are in and the figure is exact.

/** One model request, as `model_usage` records it. Times are epoch ms. */
export interface UsageRow {
  startedAt: number;
  /** First text or reasoning token; ZCode leaves it empty for a response that only calls tools. */
  firstTokenAt: number | null;
  completedAt: number | null;
  outputTokens: number;
}

/** Where the rows come from (runtime/pet-usage.ts). Throws when ZCode's database cannot be read. */
export interface UsageSource {
  /** One turn's main-session requests, finished so far. */
  turn(sessionId: string, turnId: string): UsageRow[];
  /** The session's latest finished requests; for a session without any, those of any main session. */
  recent(sessionId: string): UsageRow[];
}

/**
 * "warmup": nothing of this turn has finished yet; the value is the session's recent pace, if any.
 * "live": the pace of the turn's requests finished so far. "final": the finished turn, exact.
 */
export type TpsPhase = "warmup" | "live" | "final";
export const TPS_PHASES: readonly TpsPhase[] = ["warmup", "live", "final"];

export interface PetTps {
  /** Counts the turns followed: a new number is a new reading, the same one an update of it. */
  turn: number;
  phase: TpsPhase;
  /** Output tokens per second; null while there is nothing to go on. */
  value: number | null;
}

export const TPS_TIMING = {
  /** How long a finished turn's exact figure is shown before the readout moves on or goes away. */
  finalMs: 12_000,
  /** A turn without any event for this long is assumed over, as in pet-state.ts. */
  staleMs: 10 * 60_000,
};

type TpsTiming = typeof TPS_TIMING;

/** Less than this is too little to tell a speed from (a burst that arrived in one piece). */
const MIN_TOKENS = 8;
const MIN_MS = 250;

/**
 * Σ output tokens / Σ time from first token to completion: the speed of the writing itself, without
 * the wait for the first token or the time tools take. A row without its own first token borrows
 * one of `firstTokens` (from the log) that falls within the request; rows with neither are left out.
 */
export function pace(rows: readonly UsageRow[], firstTokens: readonly number[] = []): number | null {
  let tokens = 0;
  let ms = 0;
  for (const row of rows) {
    const end = row.completedAt;
    if (end === null || !(row.outputTokens > 0)) continue;
    const first = row.firstTokenAt ?? firstTokens.find((at) => at >= row.startedAt && at <= end);
    if (first === undefined || end <= first) continue;
    tokens += row.outputTokens;
    ms += end - first;
  }
  return tokens >= MIN_TOKENS && ms >= MIN_MS ? (tokens * 1000) / ms : null;
}

interface TpsEvent {
  event: string;
  sessionId: string;
  turnId?: string;
  querySource?: string;
  /** ttft.model.first_content: when the request's first token (text, reasoning or tool) came. */
  at?: number;
}

/** Cheap prefilter, like pet-state.ts's. */
const RELEVANT = /"event":"(?:turn\.(?:started|completed|failed)|model\.request\.completed|ttft\.model\.first_content)"/;

/** Subagents report to their parent's turn; their speed is not the main session's. */
const SUBAGENT_PREFIX = "sess_subagent_";

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function parseTpsLine(line: string): TpsEvent | null {
  if (!RELEVANT.test(line)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = record(raw);
  const event = text(entry.event);
  const sessionId = text(entry.sessionId);
  if (!event || !sessionId || sessionId.startsWith(SUBAGENT_PREFIX)) return null;
  const context = record(entry.context);
  const at = context.at;
  return {
    event,
    sessionId,
    turnId: text(entry.turnId),
    querySource: text(context.querySource),
    at: typeof at === "number" && Number.isFinite(at) ? at : undefined,
  };
}

interface Turn {
  seq: number;
  sessionId: string;
  turnId: string;
  /** First-token times from the log, for rows that lack their own. */
  firstTokens: number[];
  /** Rows changed since they were last read. */
  dirty: boolean;
  prior: number | null | undefined;
  pace: number | null;
  endedAt: number | null;
  /** Last event. */
  at: number;
}

/**
 * Follows every main session's open turn and shows one: the first to start, until it ends and its
 * exact figure has been shown; then the most recently active one still running. A new turn in the
 * shown session takes over at once. Usage rows are read only for the shown turn, and only after
 * the log said something changed.
 */
export function createTpsTracker(timing: TpsTiming = TPS_TIMING) {
  const turns = new Map<string, Turn>();
  let focus: Turn | null = null;
  let seq = 0;

  function begin(sessionId: string, turnId: string, now: number): Turn {
    const next: Turn = { seq: ++seq, sessionId, turnId, firstTokens: [], dirty: true, prior: undefined, pace: null, endedAt: null, at: now };
    turns.set(sessionId, next);
    if (!focus || focus.sessionId === sessionId) focus = next;
    return next;
  }

  /**
   * The open turn a main-session request belongs to. One not seen starting (the readout was turned
   * on mid-turn) is followed from here; its earlier requests count too, rows are read by turn id.
   */
  function requestTurn(event: TpsEvent, now: number): Turn | null {
    if (!event.turnId || event.querySource !== "main_turn") return null;
    const turn = turns.get(event.sessionId);
    if (turn?.turnId !== event.turnId) return begin(event.sessionId, event.turnId, now);
    return turn.endedAt === null ? turn : null;
  }

  function ingest(event: TpsEvent, now: number) {
    const turn = turns.get(event.sessionId);
    switch (event.event) {
      case "turn.started":
        if (event.turnId) begin(event.sessionId, event.turnId, now);
        return;
      case "ttft.model.first_content": {
        const open = requestTurn(event, now);
        if (open && event.at !== undefined) open.firstTokens.push(event.at);
        if (open) open.at = now;
        return;
      }
      case "model.request.completed": {
        const open = requestTurn(event, now);
        if (open) {
          open.dirty = true;
          open.at = now;
        }
        return;
      }
      case "turn.completed":
      case "turn.failed":
        if (!turn || turn.turnId !== event.turnId || turn.endedAt !== null) return;
        // Only the shown turn has its figure read; any other just stops being followed.
        if (turn !== focus) turns.delete(event.sessionId);
        else {
          turn.endedAt = now;
          turn.dirty = true;
        }
    }
  }

  function drop(turn: Turn) {
    if (turns.get(turn.sessionId) === turn) turns.delete(turn.sessionId);
    if (focus === turn) focus = null;
  }

  /** The reading to show now. Throws what `usage` throws; the next call tries again. */
  function reading(now: number, usage: UsageSource): PetTps | null {
    for (const turn of turns.values()) if (turn.endedAt === null && now - turn.at > timing.staleMs) drop(turn);
    if (focus?.endedAt != null && now - focus.endedAt >= timing.finalMs) drop(focus);
    if (!focus) {
      for (const turn of turns.values()) if (turn.endedAt === null && (!focus || turn.at > focus.at)) focus = turn;
      if (!focus) return null;
    }
    const turn = focus;
    if (turn.prior === undefined && turn.endedAt === null) turn.prior = pace(usage.recent(turn.sessionId));
    if (turn.dirty) {
      turn.pace = pace(usage.turn(turn.sessionId, turn.turnId), turn.firstTokens);
      turn.dirty = false;
    }
    if (turn.endedAt !== null) {
      // Stopped before anything was written: there is no figure to show.
      if (turn.pace === null) {
        drop(turn);
        return reading(now, usage);
      }
      return { turn: turn.seq, phase: "final", value: turn.pace };
    }
    return turn.pace !== null ? { turn: turn.seq, phase: "live", value: turn.pace } : { turn: turn.seq, phase: "warmup", value: turn.prior ?? null };
  }

  return { ingest, reading };
}

/** Readings that would look the same; the value only to the tenth the bubble shows. */
export function sameTps(a: PetTps | null, b: PetTps | null): boolean {
  if (!a || !b) return a === b;
  const tenth = (value: number | null) => (value === null ? null : Math.round(value * 10));
  return a.turn === b.turn && a.phase === b.phase && tenth(a.value) === tenth(b.value);
}

/** Null unless it is a reading this version would send; checked by the pages. */
export function decodeTps(raw: unknown): PetTps | null {
  const { turn, phase, value } = record(raw) as Partial<PetTps>;
  if (typeof turn !== "number" || !Number.isFinite(turn) || !TPS_PHASES.includes(phase as TpsPhase)) return null;
  if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  return { turn, phase: phase as TpsPhase, value };
}
