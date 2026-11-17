import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zcodeLogFile } from "../src/runtime/pet-log.ts";
import { createPetService, type PetPage } from "../src/runtime/pet-service.ts";
import { createUsageReader, zcodeUsageDb } from "../src/runtime/pet-usage.ts";
import { speedTier, speedWord } from "../src/runtime/pet-quotes.ts";
import { formatTps } from "../src/runtime/pet-readout.ts";
import { resolvePet, type PetPayload } from "../src/shared/pet.ts";
import { PET_TIMING } from "../src/shared/pet-state.ts";
import { createTpsTracker, decodeTps, folderName, measurePace, pace, parseTpsLine, sameTps, shortModel, TPS_TIMING, type PetTps, type UsageRow, type UsageSource } from "../src/shared/pet-tps.ts";

const MAIN = "sess_143ad587-8312-4016-b752-befbcc65d8df";
const OTHER = "sess_9f0c2a51-7d6e-4f83-a1c2-5b8e0d4f6a77";
const T1 = "turn_44383578-c35b-4878-971b-92c4332bf2a3";
const T2 = "turn_bf0aa803-f680-4da1-87bb-d1a24b0ad87d";

/** Shaped like ZCode 3.18.2's ~/.zcode/cli/log lines, trimmed to the fields that matter. */
function line(event: string, fields: Record<string, unknown> = {}, context: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: "2026-11-16T13:46:58.784Z", level: "info", event, module: "core.runtime", sessionId: MAIN, turnId: T1, ...fields, context: { turnNumber: 0, ...context } });
}
const started = (fields: Record<string, unknown> = {}) => line("turn.started", { status: "started", ...fields }, { inputLength: 24 });
const requestDone = (fields: Record<string, unknown> = {}, querySource = "main_turn") =>
  line("model.request.completed", { status: "completed", durationMs: 4071, ...fields }, { querySource, modelId: "GLM-5.3", totalTokens: "[Redacted]" });
const firstContent = (at: number, fields: Record<string, unknown> = {}, querySource = "main_turn") =>
  line("ttft.model.first_content", { module: "adapters.model", ...fields }, { querySource, at, outputKind: "tool", modelId: "GLM-5.3" });
/** The AI SDK's summary of a request's stream, logged as it ends (ZCode 3.18.2, trimmed). */
const streamDone = (at: number, chunkCounts: Record<string, number>, fields: Record<string, unknown> = {}) =>
  line("model.sdk.stream.completed", { module: "adapters.model", timestamp: new Date(at).toISOString(), status: "completed", ...fields }, { querySource: "main_turn", modelId: "zapi/claude-opus-5.5-K", transport: "sse", chunkCounts: { start: 1, "reasoning-delta": 0, "text-delta": 0, "tool-input-delta": 0, finish: 1, ...chunkCounts }, usage: { outputTokens: "[Redacted]" } });
const ended = (fields: Record<string, unknown> = {}) => line("turn.completed", { status: "completed", ...fields });

/** Node 20 (which CI runs) has no node:sqlite: the reader's own tests need it, the rest do not. */
const sqlite = (() => {
  try { return process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined; } catch { return undefined; }
})();
const needsSqlite = { skip: sqlite ? false : "node:sqlite is not available in this Node" };

const row = (startedAt: number, firstTokenAt: number | null, completedAt: number | null, outputTokens: number): UsageRow => ({ startedAt, firstTokenAt, completedAt, outputTokens });

/** A stand-in for runtime/pet-usage.ts: rows by session and turn, counting reads. */
function fakeUsage(rows: Record<string, UsageRow[]> = {}, recent: Record<string, UsageRow[]> = {}, projects: Record<string, string> = {}) {
  const reads: string[] = [];
  const source: UsageSource = {
    turn(sessionId, turnId) { reads.push(`turn ${sessionId} ${turnId}`); return rows[`${sessionId} ${turnId}`] ?? []; },
    recent(sessionId) { reads.push(`recent ${sessionId}`); return recent[sessionId] ?? []; },
    project(sessionId) { reads.push(`project ${sessionId}`); return projects[sessionId] ?? null; },
  };
  return { source, rows, reads };
}

/** What one viewer shows; `viewing` as TpsViewer's (undefined: ZCode has not said). */
const one = (tracker: ReturnType<typeof createTpsTracker>, now: number, usage: UsageSource, viewing?: string | null) =>
  tracker.readings(now, usage, [{ id: "w", viewing }]).get("w") ?? null;

function feed(tracker: ReturnType<typeof createTpsTracker>, text: string, now: number) {
  const event = parseTpsLine(text);
  assert.ok(event, text);
  tracker.ingest(event, now);
}

test("speed is output tokens over the time from first token to completion, summed over requests", () => {
  // 300 tokens in 2 s and 100 in 3 s: 400 / 5 s, not the 87.5 an average of the two speeds would give.
  assert.equal(pace([row(0, 1000, 3000, 300), row(4000, 5000, 8000, 100)]), 80);
  assert.equal(pace([row(0, 2000, 6000, 400)]), 100, "the wait for the first token does not count");
});

test("a request that only called tools borrows its first token from the log, or is left out", () => {
  const toolsOnly = row(10_000, null, 12_000, 200);
  assert.equal(pace([toolsOnly], { firstTokens: [9_000, 11_000] }), 200, "the first token logged within the request");
  assert.equal(pace([toolsOnly, row(0, 1000, 3000, 300)]), 150, "without one it is left out entirely");
  assert.equal(pace([toolsOnly], { firstTokens: [13_000] }), null);
});

test("unfinished, empty or instant requests tell no speed", () => {
  assert.equal(pace([]), null);
  assert.equal(pace([row(0, 1000, null, 500)]), null, "not finished");
  assert.equal(pace([row(0, 1000, 5000, 0)]), null, "nothing written");
  assert.equal(pace([row(0, 1000, 1000, 300)]), null, "no time passed");
  assert.equal(pace([row(0, 1000, 1100, 300)]), null, "a burst too short to time");
  assert.equal(pace([row(0, 1000, 3000, 4)]), null, "too few tokens");
});

test("log lines become events; subagents, noise and broken lines are skipped", () => {
  assert.deepEqual(parseTpsLine(firstContent(1794836806768.524)), { event: "ttft.model.first_content", sessionId: MAIN, turnId: T1, querySource: "main_turn", at: 1794836806768.524, modelId: "GLM-5.3" });
  assert.deepEqual(parseTpsLine(started()), { event: "turn.started", sessionId: MAIN, turnId: T1, querySource: undefined, at: undefined, modelId: undefined });
  assert.equal(parseTpsLine(requestDone({ sessionId: "sess_subagent_agent_26e68115" }, "subagent")), null);
  assert.equal(parseTpsLine(line("model.response.diagnostics", {}, { usageOutputTokens: "[Redacted]" })), null);
  assert.equal(parseTpsLine(line("tool.call.started")), null);
  assert.equal(parseTpsLine('{"event":"turn.started","sessionId":'), null);
  assert.equal(parseTpsLine(firstContent(Number.NaN))?.at, undefined);
});

test("a turn warms up on the session's recent pace, goes live as requests finish, and ends exact", () => {
  const usage = fakeUsage({}, { [MAIN]: [row(0, 1000, 3000, 120)] });
  const tracker = createTpsTracker();
  assert.equal(one(tracker, 0, usage.source), null, "nothing to show before a turn");
  feed(tracker, started(), 0);
  assert.deepEqual(one(tracker, 10, usage.source), { turn: 1, phase: "warmup", value: 60, source: null });

  usage.rows[`${MAIN} ${T1}`] = [row(100, 1100, 3100, 300)];
  assert.equal(one(tracker, 20, usage.source)?.phase, "warmup", "rows are read when the log says a request finished, not on every poll");
  feed(tracker, requestDone(), 3200);
  assert.deepEqual(one(tracker, 3300, usage.source), { turn: 1, phase: "live", value: 150, source: null });

  feed(tracker, firstContent(4000), 4000);
  usage.rows[`${MAIN} ${T1}`]!.push(row(3500, null, 6000, 100));
  feed(tracker, requestDone(), 6000);
  feed(tracker, ended(), 6100);
  assert.deepEqual(one(tracker, 6200, usage.source), { turn: 1, phase: "final", value: 100, source: null, wait: 750 }, "400 tokens over 2 s + 2 s; first tokens after 1 s and 0.5 s");
  assert.deepEqual(one(tracker, 6100 + TPS_TIMING.finalMs - 1, usage.source)?.phase, "final");
  assert.equal(one(tracker, 6100 + TPS_TIMING.finalMs, usage.source), null);
  assert.deepEqual(usage.reads, [`recent ${MAIN}`, `turn ${MAIN} ${T1}`, `turn ${MAIN} ${T1}`, `turn ${MAIN} ${T1}`]);
});

test("without any history the warmup has no value; a turn stopped before writing anything shows nothing", () => {
  const usage = fakeUsage();
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  assert.deepEqual(one(tracker, 0, usage.source), { turn: 1, phase: "warmup", value: null, source: null });
  feed(tracker, line("turn.failed", { status: "cancelled" }), 500);
  assert.equal(one(tracker, 600, usage.source), null);
});

test("one turn is shown at a time; the next running one takes over once the final figure has been shown", () => {
  const usage = fakeUsage({ [`${OTHER} ${T2}`]: [row(0, 1000, 2000, 90)] });
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  feed(tracker, started({ sessionId: OTHER, turnId: T2 }), 10);
  feed(tracker, requestDone({ sessionId: OTHER, turnId: T2 }), 2000);
  assert.deepEqual(one(tracker, 2000, usage.source), { turn: 1, phase: "warmup", value: null, source: null }, "the first turn to start keeps the readout");
  usage.rows[`${MAIN} ${T1}`] = [row(0, 1000, 2000, 50)];
  feed(tracker, requestDone(), 2100);
  feed(tracker, ended(), 2200);
  assert.deepEqual(one(tracker, 2300, usage.source), { turn: 1, phase: "final", value: 50, source: null, wait: 1000 });
  assert.deepEqual(one(tracker, 2200 + TPS_TIMING.finalMs, usage.source), { turn: 2, phase: "live", value: 90, source: null }, "the other session, already live");
});

test("a new turn in the shown session replaces its final figure at once; other sessions' endings pass quietly", () => {
  const usage = fakeUsage({ [`${MAIN} ${T1}`]: [row(0, 1000, 2000, 50)] });
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  feed(tracker, started({ sessionId: OTHER, turnId: T2 }), 0);
  feed(tracker, ended({ sessionId: OTHER, turnId: T2 }), 100);
  feed(tracker, requestDone(), 2000);
  feed(tracker, ended(), 2000);
  assert.equal(one(tracker, 2000, usage.source)?.phase, "final");
  feed(tracker, started({ turnId: T2 }), 3000);
  assert.deepEqual(one(tracker, 3000, usage.source), { turn: 3, phase: "warmup", value: null, source: null });
  feed(tracker, ended({ turnId: T1 }), 3100);
  assert.equal(one(tracker, 3100, usage.source)?.turn, 3, "a late ending of the replaced turn changes nothing");
});

test("only the shown turn's main-session requests are read; side requests and stale turns are ignored", () => {
  const usage = fakeUsage();
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  one(tracker, 0, usage.source);
  usage.reads.length = 0;
  feed(tracker, requestDone({}, "session_title"), 100);
  feed(tracker, requestDone({ sessionId: OTHER, turnId: T2 }), 100);
  one(tracker, 200, usage.source);
  assert.deepEqual(usage.reads, [`project ${MAIN}`], "a title, or a session not shown, reads no rows; two running now, the shown one is named");
  feed(tracker, requestDone({ turnId: T2 }), 300);
  assert.deepEqual(one(tracker, 300, usage.source), { turn: 3, phase: "warmup", value: null, source: { project: null, model: "GLM-5.3" } }, "a new turn of this session whose start went unseen takes over, named while another runs");
  assert.equal(one(tracker, 300 + TPS_TIMING.staleMs + 1, usage.source), null, "a turn silent for too long is over");
});

test("a turn already under way is picked up from its next request, earlier requests included", () => {
  const usage = fakeUsage({ [`${MAIN} ${T1}`]: [row(0, 1000, 3000, 300), row(4000, 5000, 7000, 100)] });
  const tracker = createTpsTracker();
  feed(tracker, firstContent(5000), 5000);
  assert.deepEqual(one(tracker, 5000, usage.source), { turn: 1, phase: "live", value: 100, source: null }, "400 tokens over 4 s, from before joining too");
  feed(tracker, requestDone(), 7000);
  feed(tracker, ended(), 7100);
  assert.equal(one(tracker, 7100, usage.source)?.phase, "final");
  feed(tracker, requestDone({ turnId: T2 }, "session_title"), 7200);
  assert.equal(one(tracker, 7200, usage.source)?.turn, 1, "a side request starts nothing");
});

test("a database that cannot be read is retried on the next poll", () => {
  let broken = true;
  const source: UsageSource = {
    turn: () => { if (broken) throw new Error("no such table: model_usage"); return [row(0, 1000, 2000, 40)]; },
    recent: () => { if (broken) throw new Error("no such table: model_usage"); return []; },
    project: () => null,
  };
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  assert.throws(() => one(tracker, 0, source), /model_usage/);
  broken = false;
  assert.deepEqual(one(tracker, 10, source), { turn: 1, phase: "live", value: 40, source: null });
});

test("readings compare to the tenth shown and decode only in their own shape", () => {
  assert.ok(sameTps({ turn: 1, phase: "live", value: 48.31, source: null }, { turn: 1, phase: "live", value: 48.34, source: null }));
  assert.ok(!sameTps({ turn: 1, phase: "live", value: 48.3, source: null }, { turn: 1, phase: "final", value: 48.3, source: null }));
  assert.ok(!sameTps({ turn: 1, phase: "live", value: 48.3, source: null }, null));
  assert.ok(sameTps(null, null));
  assert.deepEqual(decodeTps({ turn: 2, phase: "warmup", value: null, source: null }), { turn: 2, phase: "warmup", value: null, source: null });
  for (const bad of [null, "fast", { turn: "2", phase: "live", value: 1 }, { turn: 2, phase: "racing", value: 1, source: null }, { turn: 2, phase: "live", value: -1, source: null }, { turn: 2, phase: "live" }]) assert.equal(decodeTps(bad), null);
});

/** The columns of ZCode's `model_usage` the reader touches, plus enough of the rest to look real. */
function usageDb(file: string) {
  const db = new sqlite!.DatabaseSync(file);
  db.exec("pragma journal_mode = wal");
  db.exec(`create table model_usage (id text primary key, session_id text not null, turn_id text, query_source text not null, model_id text not null,
    status text not null, started_at integer not null, first_token_at integer, completed_at integer, output_tokens integer not null default 0, input_tokens integer not null default 0)`);
  db.exec("create index model_usage_session_turn_idx on model_usage(session_id, turn_id)");
  db.exec("create index model_usage_query_source_idx on model_usage(query_source)");
  const insert = db.prepare("insert into model_usage values (?, ?, ?, ?, 'GLM-5.3', 'completed', ?, ?, ?, ?, 90000)");
  let id = 0;
  return { db, add: (sessionId: string, turnId: string, querySource: string, r: UsageRow) => insert.run(`u${++id}`, sessionId, turnId, querySource, r.startedAt, r.firstTokenAt, r.completedAt, r.outputTokens) };
}

test("the reader finds a turn's main-session rows, and recent ones of the session or else of any session", needsSqlite, () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-pet-usage-"));
  const file = join(dir, "db.sqlite");
  const { db, add } = usageDb(file);
  add(MAIN, T1, "main_turn", row(0, 1000, 3000, 300));
  add(MAIN, T1, "main_turn", row(4000, null, 5000, 50));
  add(MAIN, T1, "session_title", row(0, 100, 200, 9));
  add(MAIN, T2, "main_turn", row(9000, 9500, 9900, 20));
  add(OTHER, T2, "main_turn", row(8000, 8100, 8200, 30));
  const reader = createUsageReader(file);
  assert.deepEqual(reader.turn(MAIN, T1), [row(0, 1000, 3000, 300), row(4000, null, 5000, 50)]);
  assert.deepEqual(reader.recent(MAIN), [row(9000, 9500, 9900, 20), row(0, 1000, 3000, 300)], "newest first, timed rows only");
  assert.deepEqual(reader.recent("sess_new"), [row(9000, 9500, 9900, 20), row(8000, 8100, 8200, 30), row(0, 1000, 3000, 300)]);
  assert.ok(existsSync(`${file}-wal`), "ZCode's write-ahead log is left alone: never checkpointed or removed");
  db.close();
});

test("an unreadable database throws, pauses reads for a while and creates nothing", needsSqlite, () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-pet-usage-"));
  let clock = 0;
  const reader = createUsageReader(join(dir, "db.sqlite"), () => clock);
  assert.throws(() => reader.turn(MAIN, T1));
  assert.deepEqual(readdirSync(dir), [], "read-only: no database is created");
  const { db, add } = usageDb(join(dir, "db.sqlite"));
  add(MAIN, T1, "main_turn", row(0, 1000, 3000, 300));
  assert.throws(() => reader.turn(MAIN, T1), "still paused");
  clock += 10_000;
  assert.equal(reader.turn(MAIN, T1).length, 1);
  db.close();

  const other = mkdtempSync(join(tmpdir(), "zc-pet-usage-"));
  new sqlite!.DatabaseSync(join(other, "db.sqlite")).close();
  assert.throws(() => createUsageReader(join(other, "db.sqlite")).turn(MAIN, T1), /model_usage/, "a ZCode from before the usage table");
});

test("the database lives where ZCode keeps it, unless ZCode was told otherwise", () => {
  assert.match(zcodeUsageDb({}), /[\\/]\.zcode[\\/]cli[\\/]db[\\/]db\.sqlite$/);
  assert.equal(zcodeUsageDb({ ZCODE_SESSION_DB_PATH: "/data/zc.sqlite" }), "/data/zc.sqlite");
  assert.equal(zcodeUsageDb({ ZCODE_SESSION_DB: "~/zc.sqlite" }), join(homedir(), "zc.sqlite"));
});

test("the service reads usage only with the readout on, and pushes readings as they change", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-pet-service-"));
  const file = zcodeLogFile(dir, new Date());
  writeFileSync(file, "");
  const sent: PetPayload[] = [];
  let clock = 0;
  const assets = { image: "file:///a.png", sounds: { duck: { press: "file:///1", release: "file:///2" }, fx1: { press: "file:///3", release: "file:///4" } } };
  const usage = fakeUsage({}, { [MAIN]: [row(0, 1000, 2000, 70)] });
  const logs: string[] = [];
  const service = createPetService({ assets, logDir: dir, usage: usage.source, pages: () => [{ id: "w", shows: true }], send: (_page, payload) => sent.push(payload), log: (message) => logs.push(message), pollMs: 60_000, now: () => clock });
  const tick = () => service.prompt(null);

  service.configure(resolvePet({ enabled: true, tps: false }));
  appendFileSync(file, `${started()}\n`);
  tick();
  assert.deepEqual(usage.reads, [], "readout off: ZCode's database is never opened");
  assert.equal(sent.at(-1)?.tps, null);

  service.configure(resolvePet({ enabled: true }));
  tick();
  assert.deepEqual(sent.at(-1)?.tps, { turn: 1, phase: "warmup", value: 70, source: null }, "turned on mid-turn, it still knows the turn");
  const count = sent.length;
  tick();
  assert.equal(sent.length, count, "an unchanged reading sends nothing");

  usage.rows[`${MAIN} ${T1}`] = [row(100, 1100, 3100, 100)];
  appendFileSync(file, `${requestDone()}\n${ended()}\n`);
  clock += PET_TIMING.holdMs;
  tick();
  assert.deepEqual([sent.at(-1)?.mood, sent.at(-1)?.tps], ["done", { turn: 1, phase: "final", value: 50, source: null, wait: 1000 }]);

  usage.source.recent = () => { throw new Error("database is locked"); };
  appendFileSync(file, `${started({ turnId: T2 })}\n`);
  clock += PET_TIMING.holdMs;
  tick();
  tick();
  assert.equal(sent.at(-1)?.tps, null, "a failed read shows nothing rather than an old figure");
  assert.equal(sent.at(-1)?.mood, "thinking", "and the mood carries on");
  assert.deepEqual(logs, ["pet speed readout unavailable: Error: database is locked"], "logged once");
});

test("speed words follow how fast models really write, and figures show the precision they have", () => {
  const said = (value: number) => speedWord(value);
  assert.equal(said(32), "慢吞吞~", "an overloaded endpoint");
  assert.equal(said(83), "唰唰唰！", "GLM-5.3, usually past 80");
  assert.equal(said(143), "唰唰唰！", "Claude Opus");
  assert.equal(said(205), "嗖嗖嗖！", "DeepSeek V4 Flash, past 200");
  assert.equal(said(301), "光速狐狐！", "Haiku");
  assert.equal(said(1346), "破表啦！", "highspeed models");
  assert.deepEqual([0, 39.9, 40, 80, 150, 300, 1000].map(speedTier), [0, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual([formatTps(48.26, "live"), formatTps(9.44, "warmup"), formatTps(48.26, "final"), formatTps(143.2, "final")], ["48", "9.4", "48.3", "143"]);
});

/** Three conversations: MAIN started first, OTHER and THIRD later; rows for each turn. */
function three() {
  const THIRD = "sess_3c5e7a91-2b4d-4f6a-8c0e-1d3f5a7b9c2e";
  const usage = fakeUsage(
    { [`${MAIN} ${T1}`]: [row(0, 1000, 2000, 50)], [`${OTHER} ${T2}`]: [row(0, 1000, 2000, 90)], [`${THIRD} ${T2}`]: [row(0, 1000, 2000, 120)] },
    {},
    { [MAIN]: "zcode-canvas", [OTHER]: "z-code", [THIRD]: "notes" },
  );
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  feed(tracker, started({ sessionId: OTHER, turnId: T2 }), 10);
  feed(tracker, requestDone(), 2000);
  feed(tracker, requestDone({ sessionId: OTHER, turnId: T2 }), 2000);
  return { usage, tracker, THIRD };
}

test("each window shows the conversation it has open, unlabelled, whichever started first", () => {
  const { usage, tracker } = three();
  const shown = tracker.readings(2000, usage.source, [{ id: "a", viewing: MAIN }, { id: "b", viewing: OTHER }]);
  assert.deepEqual(shown.get("a"), { turn: 1, phase: "live", value: 50, source: null });
  assert.deepEqual(shown.get("b"), { turn: 2, phase: "live", value: 90, source: null }, "not the turn that started first");
  assert.ok(!usage.reads.some((read) => read.startsWith("project")), "no label, no folder looked up");
});

test("an open conversation with nothing running shows the shared one, named by folder and model", () => {
  const { usage, tracker, THIRD } = three();
  const named = { project: "zcode-canvas", model: "GLM-5.3" };
  assert.deepEqual(one(tracker, 2000, usage.source, THIRD), { turn: 1, phase: "live", value: 50, source: named }, "idle conversation: the first to start, named");
  assert.deepEqual(one(tracker, 2000, usage.source, null), { turn: 1, phase: "live", value: 50, source: named }, "ZCode's start page: named too");
  assert.equal(usage.reads.filter((read) => read === `project ${MAIN}`).length, 1, "the folder is looked up once");
  feed(tracker, started({ sessionId: THIRD }), 2100);
  assert.equal(one(tracker, 2100, usage.source, THIRD)?.source, null, "once it starts a turn, it shows its own, unlabelled");
});

test("without word from ZCode a label shows only while several conversations run", () => {
  const usage = fakeUsage({ [`${MAIN} ${T1}`]: [row(0, 1000, 2000, 50)] }, {}, { [MAIN]: "zcode-canvas" });
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  feed(tracker, requestDone(), 2000);
  assert.equal(one(tracker, 2000, usage.source)?.source, null, "one running: nothing to tell apart");
  feed(tracker, started({ sessionId: OTHER, turnId: T2 }), 2100);
  assert.deepEqual(one(tracker, 2100, usage.source)?.source, { project: "zcode-canvas", model: "GLM-5.3" });
});

test("switching conversations follows at once; a finished one shows its figure, then the running one, named", () => {
  const { usage, tracker } = three();
  assert.equal(one(tracker, 2000, usage.source, MAIN)?.turn, 1);
  assert.equal(one(tracker, 2000, usage.source, OTHER)?.turn, 2, "switched");
  feed(tracker, ended({ sessionId: OTHER, turnId: T2 }), 3000);
  assert.deepEqual(one(tracker, 3000, usage.source, OTHER), { turn: 2, phase: "final", value: 90, source: null, wait: 1000 }, "its own exact figure, though not the shared one");
  assert.deepEqual(one(tracker, 3000 + TPS_TIMING.finalMs, usage.source, OTHER), { turn: 1, phase: "live", value: 50, source: { project: "zcode-canvas", model: "GLM-5.3" } });
});

test("an open conversation stopped before writing anything falls back without a gap", () => {
  const { usage, tracker } = three();
  usage.rows[`${OTHER} ${T2}`] = [];
  feed(tracker, line("turn.failed", { sessionId: OTHER, turnId: T2, status: "cancelled" }), 2500);
  assert.equal(one(tracker, 2500, usage.source, OTHER)?.turn, 1);
});

test("only turns some window shows are read; pages that hide the pet read nothing", () => {
  const { usage, tracker } = three();
  tracker.readings(2000, usage.source, [{ id: "a", viewing: OTHER }]);
  assert.deepEqual(usage.reads, [`recent ${OTHER}`, `turn ${OTHER} ${T2}`], "MAIN, started first, is not read when nobody shows it");
  usage.reads.length = 0;
  assert.equal(tracker.readings(2000, usage.source, []).size, 0);
  assert.deepEqual(usage.reads, []);
});

test("a folder that cannot be read leaves the model alone on the label, and is asked for again", () => {
  const { usage, tracker, THIRD } = three();
  let broken = true;
  const project = usage.source.project;
  usage.source.project = (sessionId) => { if (broken) throw new Error("database is locked"); return project(sessionId); };
  assert.deepEqual(one(tracker, 2000, usage.source, THIRD)?.source, { project: null, model: "GLM-5.3" });
  broken = false;
  assert.deepEqual(one(tracker, 2000, usage.source, THIRD)?.source, { project: "zcode-canvas", model: "GLM-5.3" });
});

test("folder names keep only the last part of a path; model names drop their provider", () => {
  assert.equal(folderName("/Users/kevin/codegeex/zcode-canvas"), "zcode-canvas");
  assert.equal(folderName("C:\\Users\\kevin\\work\\z-code\\"), "z-code");
  assert.equal(folderName("/"), null);
  assert.equal(folderName(null), null);
  assert.equal(folderName(`/${"x".repeat(200)}`)?.length, 64);
  assert.equal(shortModel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(shortModel("zapi/GLM-5.3-Highspeed-fusion"), "GLM-5.3-Highspeed-fusion");
  assert.equal(shortModel("api-gateway/deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(shortModel(""), null);
});

test("a reading's source is decoded as plain, bounded names, or dropped", () => {
  const base = { turn: 1, phase: "live", value: 48 };
  assert.deepEqual(decodeTps({ ...base, source: { project: "z-code", model: null } })?.source, { project: "z-code", model: null });
  assert.equal(decodeTps({ ...base, source: { project: "", model: 7 } })?.source, null, "nothing to tell: no label");
  assert.equal(decodeTps({ ...base, source: "z-code" })?.source, null);
  assert.equal(decodeTps({ ...base, source: { project: "y".repeat(500) } })?.source?.project?.length, 64);
  assert.equal(decodeTps(base)?.source, null, "a main from before sources");
});

test("the service sends each page its own reading, and none to pages that hide the pet", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-pet-service-"));
  const file = zcodeLogFile(dir, new Date());
  writeFileSync(file, "");
  const assets = { image: "file:///a.png", sounds: { duck: { press: "file:///1", release: "file:///2" }, fx1: { press: "file:///3", release: "file:///4" } } };
  const usage = fakeUsage({ [`${MAIN} ${T1}`]: [row(0, 1000, 2000, 50)], [`${OTHER} ${T2}`]: [row(0, 1000, 2000, 90)] });
  let pages: PetPage[] = [{ id: "a", shows: true, viewing: MAIN }, { id: "b", shows: true, viewing: OTHER }];
  const sent: Array<[string, PetPayload]> = [];
  const service = createPetService({ assets, logDir: dir, usage: usage.source, pages: () => pages, send: (page, payload) => sent.push([page, payload]), log: () => assert.fail("no failure"), pollMs: 60_000 });
  service.configure(resolvePet({ enabled: true }));
  appendFileSync(file, `${started()}\n${started({ sessionId: OTHER, turnId: T2 })}\n${requestDone()}\n${requestDone({ sessionId: OTHER, turnId: T2 })}\n`);
  service.refresh();
  assert.deepEqual([service.payload("a").tps?.value, service.payload("b").tps?.value], [50, 90]);
  sent.length = 0;
  pages = [{ id: "a", shows: true, viewing: OTHER }, { id: "b", shows: true, viewing: OTHER }];
  service.refresh();
  assert.deepEqual(sent.map(([page, payload]) => [page, payload.tps?.value]), [["a", 90]], "only the page that switched is sent anything");
  pages = [{ id: "a", shows: false, viewing: OTHER }, { id: "desktop", shows: true, viewing: MAIN }];
  service.refresh();
  assert.deepEqual([service.payload("a").tps, service.payload("desktop").tps?.value], [null, 50], "desktop mode: the window's pet hides, the desktop one follows");
  assert.equal(service.payload("b").tps, null, "a closed page is forgotten");
});

test("a response a relay buffered and flushed at the end is timed from the request's start", () => {
  // 1800 tokens whose first token came 300 ms before the end, in 4 chunks: 6000 tok/s, impossible.
  const relayed = row(10_000, 19_700, 20_000, 1800);
  const flushed = [{ at: 19_990, chunks: 4 }];
  assert.equal(pace([relayed]), 6000, "without the stream's summary the window is taken at its word");
  assert.equal(pace([row(10_000, 19_800, 20_000, 1800)]), null, "flushed in the last 200 ms: too short to time, nothing showed");
  assert.equal(pace([row(10_000, 19_800, 20_000, 1800)], { streams: flushed }), 180);
  assert.deepEqual(measurePace([relayed], { streams: flushed }), { value: 180, buffered: true, wait: null }, "1800 tokens over the 10 s since the request started");
  // The same burst, really streamed in 600 chunks: a fast model, left as it is.
  assert.deepEqual(measurePace([relayed], { streams: [{ at: 19_990, chunks: 600 }] }), { value: 6000, buffered: false, wait: 9700 });
  // Big chunks at a believable pace (some direct streams send ~30 tokens per chunk): left as it is.
  assert.deepEqual(measurePace([row(0, 1000, 21_000, 3000)], { streams: [{ at: 20_990, chunks: 100 }] }), { value: 150, buffered: false, wait: 1000 });
  // A tool call that came in one piece, with no first token of its own: timed from start, not dropped.
  assert.equal(pace([row(0, null, 4000, 400)], { streams: [{ at: 3990, chunks: 1 }] }), 100);
  assert.equal(pace([row(0, 1000, 3000, 200)], { fromStart: true }), (200 * 1000) / 3000, "a session known to buffer: from start");
  assert.equal(pace([relayed], { streams: [{ at: 25_000, chunks: 4 }] }), 6000, "another request's summary does not count");
});

test("log stream summaries are read from the line's own time and its delta chunks only", () => {
  const event = parseTpsLine(streamDone(Date.UTC(2026, 10, 17, 2, 0, 0), { "reasoning-delta": 11, "text-delta": 2, "tool-input-delta": 2, "tool-call": 1 }));
  assert.deepEqual(event?.stream, { at: Date.UTC(2026, 10, 17, 2, 0, 0), chunks: 15 });
  assert.equal(parseTpsLine(streamDone(0, {}, { timestamp: "soon" }))?.stream, undefined);
});

test("a relay's turn shows a believable figure instead of none, and its next warmup knows", () => {
  const usage = fakeUsage({}, { [MAIN]: [row(0, 9700, 10_000, 1500)] });
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  assert.equal(one(tracker, 0, usage.source)?.value, 5000, "before anything is known, the history looks absurdly fast");
  // Two requests flushed 100 ms before their end: 200 ms in all, too short to time, so nothing showed.
  usage.rows[`${MAIN} ${T1}`] = [row(1000, 5900, 6000, 600), row(6100, 9900, 10_000, 400)];
  assert.equal(pace(usage.rows[`${MAIN} ${T1}`]!), null);
  feed(tracker, streamDone(5990, { "reasoning-delta": 3, "tool-input-delta": 1 }), 5990);
  feed(tracker, requestDone(), 6000);
  feed(tracker, streamDone(9990, { "text-delta": 2 }), 9990);
  feed(tracker, requestDone(), 10_000);
  feed(tracker, ended(), 10_000);
  assert.deepEqual(one(tracker, 10_000, usage.source), { turn: 1, phase: "final", value: 1000 * 1000 / 8900, source: null, buffered: true }, "its waits are the relay's, not shown");
  feed(tracker, started({ turnId: T2 }), 11_000);
  assert.deepEqual(one(tracker, 11_000, usage.source), { turn: 2, phase: "warmup", value: 150, source: null }, "1500 tokens over 10 s, not 5000/s");
});

test("the final figure carries the turn's wait for first tokens; decoded only when plausible", () => {
  assert.deepEqual(measurePace([row(0, 2000, 6000, 400), row(7000, 7500, 9500, 200)]), { value: 100, buffered: false, wait: 1250 });
  assert.equal(measurePace([row(0, null, 4000, 400)]).wait, null, "nothing timed, nothing to say");
  const base = { turn: 1, phase: "final", value: 48, source: null };
  assert.equal(decodeTps({ ...base, wait: 2300 })?.wait, 2300);
  assert.equal(decodeTps({ ...base, wait: -1 })?.wait, undefined);
  assert.equal(decodeTps({ ...base, wait: "2s" })?.wait, undefined);
  assert.deepEqual(decodeTps({ ...base, wait: 2300, buffered: true }), { ...base, buffered: true }, "a buffered figure has no wait to show");
  assert.ok(!sameTps({ ...base, wait: 2300 } as PetTps, { ...base, wait: 2600 } as PetTps));
  assert.ok(sameTps({ ...base, wait: 2310 } as PetTps, { ...base, wait: 2340 } as PetTps), "the bubble shows tenths of a second");
});
