// The pet's speed readout: output tokens per second of a main session's current turn. Pure, no
// node or DOM imports: tested against recorded log lines and usage rows. Three inputs, all ZCode
// internals (docs/design.md §3):
//
// - ZCode's JSONL event log, the one pet-state.ts follows: when a main session's turn starts and
//   ends, when each of its model requests finishes, when each request's first token came, and on
//   which model.
// - ZCode's usage table `model_usage` (runtime/pet-usage.ts): one row per model request, written
//   as the request finishes, with its exact output token count; and the `session` table, for the
//   project folder a session works in.
// - Which conversation each ZCode window has open, as its renderer reports it to the main process
//   (main.ts): every pet shows that conversation's speed first.
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
  /** The name of the folder the session works in, without the rest of its path; null if unknown. */
  project(sessionId: string): string | null;
}

/**
 * "warmup": nothing of this turn has finished yet; the value is the session's recent pace, if any.
 * "live": the pace of the turn's requests finished so far. "final": the finished turn, exact.
 */
export type TpsPhase = "warmup" | "live" | "final";
export const TPS_PHASES: readonly TpsPhase[] = ["warmup", "live", "final"];

/** Whose speed it is, shown when it may not be the conversation the user is looking at. */
export interface TpsSource {
  project: string | null;
  model: string | null;
}

export interface PetTps {
  /** Counts the turns followed: a new number is a new reading, the same one an update of it. */
  turn: number;
  phase: TpsPhase;
  /** Output tokens per second; null while there is nothing to go on. */
  value: number | null;
  /** Null when it is the conversation open where the pet is shown, or nothing could tell them apart. */
  source: TpsSource | null;
  /** Final readings only: the turn's average wait for a request's first token, in ms, when known. */
  wait?: number;
  /** Some request came buffered by a relay and was timed from its start: the figure includes waiting. */
  buffered?: boolean;
}

/** A place showing the readout: a ZCode window's pet, or the one desktop pet. */
export interface TpsViewer {
  id: string;
  /**
   * The conversation open there: a session id; null when none is (ZCode's start page); undefined
   * while ZCode has not said, as an older ZCode never does.
   */
  viewing?: string | null;
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

/** A request's stream as the log summed it up when it ended: when, and in how many delta chunks. */
export interface StreamSummary {
  at: number;
  chunks: number;
}

/** What the log adds to a turn's rows. */
export interface PaceHints {
  /** First-token times, for rows that lack their own. */
  firstTokens?: readonly number[];
  streams?: readonly StreamSummary[];
  /** Time every row from its start: the session's streams are known to come buffered. */
  fromStart?: boolean;
}

/**
 * Relays that buffer a response and flush it in a few large pieces at the end make the window from
 * first token to completion meaningless: it no longer covers the writing. Measured on real streams,
 * direct streams carry 1–12 tokens per chunk (some up to ~30, but then spread over hundreds of
 * chunks at a plausible speed); buffering relays carry 16–350 tokens per chunk and appear to write
 * thousands of tokens per second. Both together mark a buffered response.
 */
const BURST_TOKENS_PER_CHUNK = 16;
const BURST_RATE = 600;

function buffered(row: UsageRow, end: number, first: number | undefined, stream: StreamSummary | undefined): boolean {
  if (!stream || !(stream.chunks > 0) || row.outputTokens / stream.chunks <= BURST_TOKENS_PER_CHUNK) return false;
  return first === undefined || end <= first || (row.outputTokens * 1000) / (end - first) > BURST_RATE;
}

/**
 * Σ output tokens / Σ time from first token to completion: the speed of the writing itself, without
 * the wait for the first token or the time tools take. A row without its own first token borrows
 * one of the log's first-token times that falls within the request; rows with neither are left out.
 * A buffered response is timed from the request's start instead, the only bound left: its figure
 * includes the wait for the first token. `buffered` says whether any row was.
 */
export function measurePace(rows: readonly UsageRow[], hints: PaceHints = {}): { value: number | null; buffered: boolean; wait: number | null } {
  let tokens = 0;
  let ms = 0;
  let anyBuffered = false;
  let waited = 0;
  let waits = 0;
  for (const row of rows) {
    const end = row.completedAt;
    if (end === null || !(row.outputTokens > 0)) continue;
    let first = row.firstTokenAt ?? hints.firstTokens?.find((at) => at >= row.startedAt && at <= end);
    const stream = hints.streams?.find((each) => each.at >= row.startedAt && each.at <= end + STREAM_SLACK_MS);
    if (hints.fromStart || buffered(row, end, first, stream)) {
      first = row.startedAt;
      anyBuffered ||= !hints.fromStart;
    }
    if (first === undefined || end <= first) continue;
    tokens += row.outputTokens;
    ms += end - first;
    if (first > row.startedAt) {
      waited += first - row.startedAt;
      waits++;
    }
  }
  return { value: tokens >= MIN_TOKENS && ms >= MIN_MS ? (tokens * 1000) / ms : null, buffered: anyBuffered, wait: waits ? waited / waits : null };
}

/** The stream's summary is logged as it ends, just before the row's completion time is taken. */
const STREAM_SLACK_MS = 50;

export function pace(rows: readonly UsageRow[], hints: PaceHints = {}): number | null {
  return measurePace(rows, hints).value;
}

/** Longest name passed on; the bubble shortens it further to what fits. */
const NAME_MAX = 64;

/** The last part of a path, Windows or POSIX; null for an empty one. */
export function folderName(path: string | null | undefined): string | null {
  const name = (path ?? "").split(/[\\/]+/).filter(Boolean).at(-1) ?? "";
  return name ? name.slice(0, NAME_MAX) : null;
}

/** "zapi/GLM-5.3" → "GLM-5.3", "claude-opus-5-5" → "Opus 5.5"; anything else as it is. */
export function shortModel(modelId: string | null | undefined): string | null {
  const id = (modelId ?? "").split("/").filter(Boolean).at(-1) ?? "";
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/i.exec(id);
  const name = claude ? `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}` : id;
  return name ? name.slice(0, NAME_MAX) : null;
}

interface TpsEvent {
  event: string;
  sessionId: string;
  turnId?: string;
  querySource?: string;
  /** ttft.model.first_content: when the request's first token (text, reasoning or tool) came. */
  at?: number;
  modelId?: string;
  /** model.sdk.stream.completed: when it was logged and its text, reasoning and tool-input delta chunks. */
  stream?: StreamSummary;
}

/** Cheap prefilter, like pet-state.ts's. */
const RELEVANT = /"event":"(?:turn\.(?:started|completed|failed)|model\.request\.completed|ttft\.model\.first_content|model\.sdk\.stream\.completed)"/;

const DELTA_CHUNKS = ["text-delta", "reasoning-delta", "tool-input-delta"];

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
  const parsed: TpsEvent = {
    event,
    sessionId,
    turnId: text(entry.turnId),
    querySource: text(context.querySource),
    at: typeof at === "number" && Number.isFinite(at) ? at : undefined,
    modelId: text(context.modelId),
  };
  if (event === "model.sdk.stream.completed") {
    const loggedAt = Date.parse(text(entry.timestamp) ?? "");
    const counts = record(context.chunkCounts);
    const chunks = DELTA_CHUNKS.reduce((sum, kind) => sum + (typeof counts[kind] === "number" && Number.isFinite(counts[kind]) ? (counts[kind] as number) : 0), 0);
    if (Number.isFinite(loggedAt)) parsed.stream = { at: loggedAt, chunks };
  }
  return parsed;
}

interface Turn {
  seq: number;
  sessionId: string;
  turnId: string;
  /** First-token times from the log, for rows that lack their own. */
  firstTokens: number[];
  /** Stream summaries from the log, to tell buffered responses. */
  streams: StreamSummary[];
  /** The model of its latest request, from the log. */
  model: string | null;
  /** Rows changed since they were last read. */
  dirty: boolean;
  prior: number | null | undefined;
  pace: number | null;
  /** From the last read of its rows; see PetTps. */
  wait: number | null;
  buffered: boolean;
  endedAt: number | null;
  /** Last event. */
  at: number;
}

/**
 * Follows every main session's open turn, and the finished ones while their exact figure is shown.
 * Each viewer is shown the conversation open there, if it has a turn running or just finished;
 * otherwise a shared fallback, labelled with whose it is: the first turn to start, until it ends
 * and its exact figure has been shown, then the most recently active one still running. Usage rows
 * are read only for turns some viewer shows, and only after the log said something changed.
 */
export function createTpsTracker(timing: TpsTiming = TPS_TIMING) {
  const turns = new Map<string, Turn>();
  /** The shared fallback. */
  let focus: Turn | null = null;
  let seq = 0;
  /** Sessions whose responses came buffered, by a relay (see BURST_TOKENS_PER_CHUNK). */
  const bufferedSessions = new Set<string>();
  /** Folder names by session, once read; a session never moves. */
  const projects = new Map<string, string | null>();

  function begin(sessionId: string, turnId: string, now: number): Turn {
    const next: Turn = { seq: ++seq, sessionId, turnId, firstTokens: [], streams: [], model: null, dirty: true, prior: undefined, pace: null, wait: null, buffered: false, endedAt: null, at: now };
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
      case "ttft.model.first_content":
      case "model.sdk.stream.completed":
      case "model.request.completed": {
        const open = requestTurn(event, now);
        if (!open) return;
        open.at = now;
        if (event.modelId) open.model = event.modelId;
        if (event.event === "model.request.completed") open.dirty = true;
        else if (event.stream) open.streams.push(event.stream);
        else if (event.at !== undefined) open.firstTokens.push(event.at);
        return;
      }
      case "turn.completed":
      case "turn.failed":
        if (!turn || turn.turnId !== event.turnId || turn.endedAt !== null) return;
        turn.endedAt = now;
        turn.dirty = true;
    }
  }

  function drop(turn: Turn) {
    if (turns.get(turn.sessionId) === turn) turns.delete(turn.sessionId);
    if (focus === turn) focus = null;
  }

  /** The turn's reading, its rows read if anything changed; null for a turn stopped before writing anything. */
  function measure(turn: Turn, usage: UsageSource): PetTps | null {
    // The log holds no stream summaries for history: a session seen buffering times it all from start.
    if (turn.prior === undefined && turn.endedAt === null) turn.prior = pace(usage.recent(turn.sessionId), { fromStart: bufferedSessions.has(turn.sessionId) });
    if (turn.dirty) {
      const measured = measurePace(usage.turn(turn.sessionId, turn.turnId), { firstTokens: turn.firstTokens, streams: turn.streams });
      if (measured.buffered) bufferedSessions.add(turn.sessionId);
      turn.pace = measured.value;
      turn.wait = measured.wait;
      turn.buffered = measured.buffered;
      turn.dirty = false;
    }
    if (turn.endedAt !== null) {
      if (turn.pace === null) {
        drop(turn);
        return null;
      }
      const final: PetTps = { turn: turn.seq, phase: "final", value: turn.pace, source: null };
      // A buffered turn's waits end when the relay flushed, not when the model began: not shown.
      if (turn.buffered) final.buffered = true;
      else if (turn.wait !== null) final.wait = turn.wait;
      return final;
    }
    return turn.pace !== null
      ? { turn: turn.seq, phase: "live", value: turn.pace, source: null }
      : { turn: turn.seq, phase: "warmup", value: turn.prior ?? null, source: null };
  }

  /** A failed read leaves the name unknown this time and asks again next time. */
  function projectOf(sessionId: string, usage: UsageSource): string | null {
    if (projects.has(sessionId)) return projects.get(sessionId)!;
    try {
      const name = folderName(usage.project(sessionId));
      projects.set(sessionId, name);
      return name;
    } catch {
      return null;
    }
  }

  /** The shared fallback's reading, moving on past turns that end without a figure. */
  function fallback(now: number, usage: UsageSource): [Turn, PetTps] | null {
    for (;;) {
      if (!focus) for (const turn of turns.values()) if (turn.endedAt === null && (!focus || turn.at > focus.at)) focus = turn;
      if (!focus) return null;
      const turn = focus;
      const reading = measure(turn, usage);
      if (reading) return [turn, reading];
    }
  }

  /** What each viewer shows now, by viewer id. Throws what `usage` throws; the next call tries again. */
  function readings(now: number, usage: UsageSource, viewers: readonly TpsViewer[]): Map<string, PetTps | null> {
    for (const turn of [...turns.values()]) {
      if (turn.endedAt === null ? now - turn.at > timing.staleMs : now - turn.endedAt >= timing.finalMs) drop(turn);
    }
    const shown = new Map<string, PetTps | null>();
    for (const viewer of viewers) {
      const own = typeof viewer.viewing === "string" ? turns.get(viewer.viewing) : undefined;
      const mine = own ? measure(own, usage) : null;
      if (mine) {
        shown.set(viewer.id, mine);
        continue;
      }
      const other = fallback(now, usage);
      if (!other) {
        shown.set(viewer.id, null);
        continue;
      }
      const [turn, reading] = other;
      // Without word from ZCode, a label is only needed when more than one conversation is running.
      let running = 0;
      for (const each of turns.values()) if (each.endedAt === null) running++;
      const source = viewer.viewing !== undefined || running > 1 ? { project: projectOf(turn.sessionId, usage), model: shortModel(turn.model) } : null;
      shown.set(viewer.id, source && (source.project || source.model) ? { ...reading, source } : reading);
    }
    return shown;
  }

  return { ingest, readings };
}

const sameSource = (a: TpsSource | null, b: TpsSource | null) => (a && b ? a.project === b.project && a.model === b.model : a === b);

/** Readings that would look the same; the value only to the tenth the bubble shows. */
export function sameTps(a: PetTps | null, b: PetTps | null): boolean {
  if (!a || !b) return a === b;
  const tenth = (value: number | null) => (value === null ? null : Math.round(value * 10));
  const hundred = (wait: number | undefined) => (wait === undefined ? null : Math.round(wait / 100));
  return a.turn === b.turn && a.phase === b.phase && tenth(a.value) === tenth(b.value) && sameSource(a.source, b.source)
    && hundred(a.wait) === hundred(b.wait) && !!a.buffered === !!b.buffered;
}

const name = (value: unknown): string | null => (typeof value === "string" && value ? value.slice(0, NAME_MAX) : null);

/** Null unless it is a reading this version would send; checked by the pages. */
export function decodeTps(raw: unknown): PetTps | null {
  const { turn, phase, value, source, wait, buffered } = record(raw) as Partial<PetTps>;
  if (typeof turn !== "number" || !Number.isFinite(turn) || !TPS_PHASES.includes(phase as TpsPhase)) return null;
  if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  // A source that tells nothing is dropped; one from a main before sources were sent is absent.
  const from = record(source);
  const project = name(from.project), model = name(from.model);
  const reading: PetTps = { turn, phase: phase as TpsPhase, value, source: project || model ? { project, model } : null };
  if (buffered === true) reading.buffered = true;
  else if (typeof wait === "number" && Number.isFinite(wait) && wait >= 0 && wait < 3_600_000) reading.wait = wait;
  return reading;
}
