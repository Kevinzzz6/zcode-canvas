// Turns ZCode's activity into the one mood the pet shows. Pure, no node or DOM imports: tested
// against recorded log lines. Two inputs, each with its own parser so every dependency on ZCode's
// internals lives here (docs/design.md §3):
//
// - ZCode's JSONL event log (~/.zcode/cli/log/zcode-<local date>.jsonl), for turns and tools.
// - ZCode's own `zcode:show-task-notification` IPC, sent when a question or approval card appears.
//   The log has nothing while ZCode waits for the user, so this is the only "waiting" signal.
//
// Sessions are tracked separately and merged by urgency, so a question waiting in one session is
// never hidden by another session that is merely busy. Subagents log under their own session id
// (`sess_subagent_<agentId>`) and are closed by the parent's subagent.* event.

export type PetMood = "idle" | "thinking" | "working" | "waiting" | "done" | "error";

export const PET_MOODS: readonly PetMood[] = ["idle", "thinking", "working", "waiting", "done", "error"];

/** Most urgent first. */
const URGENCY: readonly PetMood[] = ["waiting", "error", "working", "thinking", "done", "idle"];

export const PET_TIMING = {
  /** How long "done" / "error" stay before the pet calms down to idle. */
  resultMs: 30_000,
  /** An open turn without any event for this long is assumed over (ZCode quit mid-turn, a lost line). */
  staleMs: 10 * 60_000,
  /** A card nobody answered for this long is assumed gone. */
  promptStaleMs: 4 * 60 * 60_000,
  /** Minimum time a calm mood is shown before another calm mood replaces it. */
  holdMs: 1500,
};

type PetTiming = typeof PET_TIMING;

interface PetEvent {
  /** A ZCode log event name, or PROMPT_SHOWN. */
  event: string;
  sessionId: string;
  toolCallId?: string;
  status?: string;
  agentId?: string;
  querySource?: string;
  /** Pairs a shown card with its tool.permission.resolved: the card's interaction id (`perm_…`). */
  requestId?: string;
}

/** Not a log event: a question or approval card appeared (parsePromptNotification). */
export const PROMPT_SHOWN = "canvas.prompt.shown";

/** Cards that go through ZCode's permission flow end with a tool.permission.resolved of the same id. */
const PERMISSION_PREFIX = "perm_";
const SUBAGENT_PREFIX = "sess_subagent_";
const isSubagent = (sessionId: string) => sessionId.startsWith(SUBAGENT_PREFIX);

/** Cheap prefilter: most log lines are model diagnostics and persistence noise. */
const RELEVANT = /"event":"(?:turn\.(?:started|completed|failed)|model\.request\.started|tool\.call\.(?:started|completed|failed)|tool\.permission\.resolved|subagent\.(?:completed|failed|background\.(?:completed|stopped|failed)))"/;

/** Query sources that belong to a user-visible turn; others (titles, summaries) never open one. */
const TURN_SOURCES = new Set(["main_turn", "subagent"]);

const PROMPT_STATUSES = new Set(["permission_request", "elicitation_request"]);

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function parseLogLine(line: string): PetEvent | null {
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
  if (!event || !sessionId) return null;
  const context = record(entry.context);
  return {
    event,
    sessionId,
    toolCallId: text(entry.toolCallId),
    status: text(entry.status),
    agentId: text(context.agentId),
    querySource: text(context.querySource),
    requestId: text(context.requestId),
  };
}

/**
 * ZCode's task notification (packages/shared validation.ts `taskNotificationPayloadSchema`):
 * `taskId` is the session, `requestId` the card's interaction id. Completion notices are ignored;
 * the log reports those.
 */
export function parsePromptNotification(payload: unknown): PetEvent | null {
  const notice = record(payload);
  const sessionId = text(notice.taskId);
  if (!sessionId || !PROMPT_STATUSES.has(notice.status as string)) return null;
  return { event: PROMPT_SHOWN, sessionId, requestId: text(notice.requestId) ?? sessionId };
}

interface Session {
  open: boolean;
  /** Running tool calls. */
  tools: Set<string>;
  result: "done" | "error" | null;
  /** Last event, or when the result was reached. */
  at: number;
}

export function createPetTracker(timing: PetTiming = PET_TIMING) {
  const sessions = new Map<string, Session>();
  /** Shown cards not answered yet, by interaction id. */
  const prompts = new Map<string, { sessionId: string; at: number }>();

  function opened(id: string, now: number): Session {
    const session = sessions.get(id) ?? { open: true, tools: new Set<string>(), result: null, at: now };
    session.open = true;
    session.result = null;
    session.at = now;
    sessions.set(id, session);
    return session;
  }

  function finish(id: string, result: Session["result"], now: number) {
    for (const [requestId, prompt] of prompts) if (prompt.sessionId === id) prompts.delete(requestId);
    if (result) sessions.set(id, { open: false, tools: new Set(), result, at: now });
    else sessions.delete(id);
  }

  /** Activity outside a known turn only counts when it belongs to a turn (pet enabled mid-turn). */
  const opens = (event: PetEvent) => sessions.get(event.sessionId)?.open === true || TURN_SOURCES.has(event.querySource ?? "");

  function ingest(event: PetEvent, now: number) {
    if (event.event === PROMPT_SHOWN) {
      // Every window showing the card reports it; the first report counts.
      if (event.requestId && !prompts.has(event.requestId)) prompts.set(event.requestId, { sessionId: event.sessionId, at: now });
      return;
    }
    // Cards outside the permission flow (an MCP server asking for input) log no resolution; the
    // session moving on means it was answered.
    for (const [requestId, prompt] of prompts) {
      if (prompt.sessionId === event.sessionId && !requestId.startsWith(PERMISSION_PREFIX)) prompts.delete(requestId);
    }
    switch (event.event) {
      case "turn.started":
        opened(event.sessionId, now).tools.clear();
        break;
      case "model.request.started":
        if (opens(event)) opened(event.sessionId, now);
        break;
      case "tool.call.started":
        if (opens(event)) opened(event.sessionId, now).tools.add(event.toolCallId ?? "");
        break;
      case "tool.call.completed":
      case "tool.call.failed": {
        const session = sessions.get(event.sessionId);
        if (!session?.open) break;
        session.tools.delete(event.toolCallId ?? "");
        session.at = now;
        break;
      }
      // Answered, approved or denied alike.
      case "tool.permission.resolved":
        if (event.requestId) prompts.delete(event.requestId);
        break;
      // A subagent's own turn ending is not news for the user; its parent's turn reports the outcome.
      case "turn.completed":
        finish(event.sessionId, isSubagent(event.sessionId) ? null : "done", now);
        break;
      case "turn.failed":
        // Stopping a turn by hand is logged as a failure with status "cancelled": not an error.
        finish(event.sessionId, isSubagent(event.sessionId) || event.status === "cancelled" ? null : "error", now);
        break;
      default:
        // subagent.completed / subagent.background.*: logged by the parent, naming the child.
        if (event.event.startsWith("subagent.") && event.agentId) sessions.delete(`${SUBAGENT_PREFIX}${event.agentId}`);
    }
  }

  function sessionMood(session: Session, now: number): PetMood | null {
    const age = now - session.at;
    if (!session.open) return session.result && age < timing.resultMs ? session.result : null;
    if (age > timing.staleMs) return null;
    return session.tools.size ? "working" : "thinking";
  }

  function mood(now: number): PetMood {
    for (const [requestId, prompt] of prompts) if (now - prompt.at > timing.promptStaleMs) prompts.delete(requestId);
    let best = prompts.size ? 0 : URGENCY.length - 1;
    for (const [id, session] of sessions) {
      const own = sessionMood(session, now);
      if (own === null) sessions.delete(id);
      else best = Math.min(best, URGENCY.indexOf(own));
    }
    return URGENCY[best]!;
  }

  return { ingest, mood };
}

/**
 * Calm moods (idle / thinking / working) alternate many times a second while an agent works; each
 * is held for `holdMs` before another calm mood replaces it. Moods that ask for attention show at once.
 */
export function createMoodStabilizer(holdMs: number) {
  let shown: PetMood = "idle";
  let since = -Infinity;
  const calm = (mood: PetMood) => mood === "idle" || mood === "thinking" || mood === "working";
  return (next: PetMood, now: number): PetMood => {
    if (next !== shown && (!calm(next) || now - since >= holdMs)) {
      shown = next;
      since = now;
    }
    return shown;
  };
}
