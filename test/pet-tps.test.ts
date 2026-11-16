import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zcodeLogFile } from "../src/runtime/pet-log.ts";
import { createPetService } from "../src/runtime/pet-service.ts";
import { createUsageReader, zcodeUsageDb } from "../src/runtime/pet-usage.ts";
import { speedTier, speedWord } from "../src/runtime/pet-quotes.ts";
import { formatTps } from "../src/runtime/pet-readout.ts";
import { resolvePet, type PetPayload } from "../src/shared/pet.ts";
import { PET_TIMING } from "../src/shared/pet-state.ts";
import { createTpsTracker, decodeTps, pace, parseTpsLine, sameTps, TPS_TIMING, type UsageRow, type UsageSource } from "../src/shared/pet-tps.ts";

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
  line("ttft.model.first_content", { module: "adapters.model", ...fields }, { querySource, at, outputKind: "tool" });
const ended = (fields: Record<string, unknown> = {}) => line("turn.completed", { status: "completed", ...fields });

/** Node 20 (which CI runs) has no node:sqlite: the reader's own tests need it, the rest do not. */
const sqlite = (() => {
  try { return process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined; } catch { return undefined; }
})();
const needsSqlite = { skip: sqlite ? false : "node:sqlite is not available in this Node" };

const row = (startedAt: number, firstTokenAt: number | null, completedAt: number | null, outputTokens: number): UsageRow => ({ startedAt, firstTokenAt, completedAt, outputTokens });

/** A stand-in for runtime/pet-usage.ts: rows by session and turn, counting reads. */
function fakeUsage(rows: Record<string, UsageRow[]> = {}, recent: Record<string, UsageRow[]> = {}) {
  const reads: string[] = [];
  const source: UsageSource = {
    turn(sessionId, turnId) { reads.push(`turn ${sessionId} ${turnId}`); return rows[`${sessionId} ${turnId}`] ?? []; },
    recent(sessionId) { reads.push(`recent ${sessionId}`); return recent[sessionId] ?? []; },
  };
  return { source, rows, reads };
}

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
  assert.equal(pace([toolsOnly], [9_000, 11_000]), 200, "the first token logged within the request");
  assert.equal(pace([toolsOnly, row(0, 1000, 3000, 300)]), 150, "without one it is left out entirely");
  assert.equal(pace([toolsOnly], [13_000]), null);
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
  assert.deepEqual(parseTpsLine(firstContent(1794836806768.524)), { event: "ttft.model.first_content", sessionId: MAIN, turnId: T1, querySource: "main_turn", at: 1794836806768.524 });
  assert.deepEqual(parseTpsLine(started()), { event: "turn.started", sessionId: MAIN, turnId: T1, querySource: undefined, at: undefined });
  assert.equal(parseTpsLine(requestDone({ sessionId: "sess_subagent_agent_26e68115" }, "subagent")), null);
  assert.equal(parseTpsLine(line("model.response.diagnostics", {}, { usageOutputTokens: "[Redacted]" })), null);
  assert.equal(parseTpsLine(line("tool.call.started")), null);
  assert.equal(parseTpsLine('{"event":"turn.started","sessionId":'), null);
  assert.equal(parseTpsLine(firstContent(Number.NaN))?.at, undefined);
});

test("a turn warms up on the session's recent pace, goes live as requests finish, and ends exact", () => {
  const usage = fakeUsage({}, { [MAIN]: [row(0, 1000, 3000, 120)] });
  const tracker = createTpsTracker();
  assert.equal(tracker.reading(0, usage.source), null, "nothing to show before a turn");
  feed(tracker, started(), 0);
  assert.deepEqual(tracker.reading(10, usage.source), { turn: 1, phase: "warmup", value: 60 });

  usage.rows[`${MAIN} ${T1}`] = [row(100, 1100, 3100, 300)];
  assert.equal(tracker.reading(20, usage.source)?.phase, "warmup", "rows are read when the log says a request finished, not on every poll");
  feed(tracker, requestDone(), 3200);
  assert.deepEqual(tracker.reading(3300, usage.source), { turn: 1, phase: "live", value: 150 });

  feed(tracker, firstContent(4000), 4000);
  usage.rows[`${MAIN} ${T1}`]!.push(row(3500, null, 6000, 100));
  feed(tracker, requestDone(), 6000);
  feed(tracker, ended(), 6100);
  assert.deepEqual(tracker.reading(6200, usage.source), { turn: 1, phase: "final", value: 100 }, "400 tokens over 2 s + 2 s");
  assert.deepEqual(tracker.reading(6100 + TPS_TIMING.finalMs - 1, usage.source)?.phase, "final");
  assert.equal(tracker.reading(6100 + TPS_TIMING.finalMs, usage.source), null);
  assert.deepEqual(usage.reads, [`recent ${MAIN}`, `turn ${MAIN} ${T1}`, `turn ${MAIN} ${T1}`, `turn ${MAIN} ${T1}`]);
});

test("without any history the warmup has no value; a turn stopped before writing anything shows nothing", () => {
  const usage = fakeUsage();
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  assert.deepEqual(tracker.reading(0, usage.source), { turn: 1, phase: "warmup", value: null });
  feed(tracker, line("turn.failed", { status: "cancelled" }), 500);
  assert.equal(tracker.reading(600, usage.source), null);
});

test("one turn is shown at a time; the next running one takes over once the final figure has been shown", () => {
  const usage = fakeUsage({ [`${OTHER} ${T2}`]: [row(0, 1000, 2000, 90)] });
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  feed(tracker, started({ sessionId: OTHER, turnId: T2 }), 10);
  feed(tracker, requestDone({ sessionId: OTHER, turnId: T2 }), 2000);
  assert.deepEqual(tracker.reading(2000, usage.source), { turn: 1, phase: "warmup", value: null }, "the first turn to start keeps the readout");
  usage.rows[`${MAIN} ${T1}`] = [row(0, 1000, 2000, 50)];
  feed(tracker, requestDone(), 2100);
  feed(tracker, ended(), 2200);
  assert.deepEqual(tracker.reading(2300, usage.source), { turn: 1, phase: "final", value: 50 });
  assert.deepEqual(tracker.reading(2200 + TPS_TIMING.finalMs, usage.source), { turn: 2, phase: "live", value: 90 }, "the other session, already live");
});

test("a new turn in the shown session replaces its final figure at once; other sessions' endings pass quietly", () => {
  const usage = fakeUsage({ [`${MAIN} ${T1}`]: [row(0, 1000, 2000, 50)] });
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  feed(tracker, started({ sessionId: OTHER, turnId: T2 }), 0);
  feed(tracker, ended({ sessionId: OTHER, turnId: T2 }), 100);
  feed(tracker, requestDone(), 2000);
  feed(tracker, ended(), 2000);
  assert.equal(tracker.reading(2000, usage.source)?.phase, "final");
  feed(tracker, started({ turnId: T2 }), 3000);
  assert.deepEqual(tracker.reading(3000, usage.source), { turn: 3, phase: "warmup", value: null });
  feed(tracker, ended({ turnId: T1 }), 3100);
  assert.equal(tracker.reading(3100, usage.source)?.turn, 3, "a late ending of the replaced turn changes nothing");
});

test("only the shown turn's main-session requests are read; side requests and stale turns are ignored", () => {
  const usage = fakeUsage();
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  tracker.reading(0, usage.source);
  usage.reads.length = 0;
  feed(tracker, requestDone({}, "session_title"), 100);
  feed(tracker, requestDone({ sessionId: OTHER, turnId: T2 }), 100);
  tracker.reading(200, usage.source);
  assert.deepEqual(usage.reads, [], "a title, or a session not shown, changes nothing here");
  feed(tracker, requestDone({ turnId: T2 }), 300);
  assert.deepEqual(tracker.reading(300, usage.source), { turn: 3, phase: "warmup", value: null }, "a new turn of this session whose start went unseen takes over");
  assert.equal(tracker.reading(300 + TPS_TIMING.staleMs + 1, usage.source), null, "a turn silent for too long is over");
});

test("a turn already under way is picked up from its next request, earlier requests included", () => {
  const usage = fakeUsage({ [`${MAIN} ${T1}`]: [row(0, 1000, 3000, 300), row(4000, 5000, 7000, 100)] });
  const tracker = createTpsTracker();
  feed(tracker, firstContent(5000), 5000);
  assert.deepEqual(tracker.reading(5000, usage.source), { turn: 1, phase: "live", value: 100 }, "400 tokens over 4 s, from before joining too");
  feed(tracker, requestDone(), 7000);
  feed(tracker, ended(), 7100);
  assert.equal(tracker.reading(7100, usage.source)?.phase, "final");
  feed(tracker, requestDone({ turnId: T2 }, "session_title"), 7200);
  assert.equal(tracker.reading(7200, usage.source)?.turn, 1, "a side request starts nothing");
});

test("a database that cannot be read is retried on the next poll", () => {
  let broken = true;
  const source: UsageSource = {
    turn: () => { if (broken) throw new Error("no such table: model_usage"); return [row(0, 1000, 2000, 40)]; },
    recent: () => { if (broken) throw new Error("no such table: model_usage"); return []; },
  };
  const tracker = createTpsTracker();
  feed(tracker, started(), 0);
  assert.throws(() => tracker.reading(0, source), /model_usage/);
  broken = false;
  assert.deepEqual(tracker.reading(10, source), { turn: 1, phase: "live", value: 40 });
});

test("readings compare to the tenth shown and decode only in their own shape", () => {
  assert.ok(sameTps({ turn: 1, phase: "live", value: 48.31 }, { turn: 1, phase: "live", value: 48.34 }));
  assert.ok(!sameTps({ turn: 1, phase: "live", value: 48.3 }, { turn: 1, phase: "final", value: 48.3 }));
  assert.ok(!sameTps({ turn: 1, phase: "live", value: 48.3 }, null));
  assert.ok(sameTps(null, null));
  assert.deepEqual(decodeTps({ turn: 2, phase: "warmup", value: null }), { turn: 2, phase: "warmup", value: null });
  for (const bad of [null, "fast", { turn: "2", phase: "live", value: 1 }, { turn: 2, phase: "racing", value: 1 }, { turn: 2, phase: "live", value: -1 }, { turn: 2, phase: "live" }]) assert.equal(decodeTps(bad), null);
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
  const service = createPetService({ assets, logDir: dir, usage: usage.source, send: (payload) => sent.push(payload), log: (message) => logs.push(message), pollMs: 60_000, now: () => clock });
  const tick = () => service.prompt(null);

  service.configure(resolvePet({ enabled: true, tps: false }));
  appendFileSync(file, `${started()}\n`);
  tick();
  assert.deepEqual(usage.reads, [], "readout off: ZCode's database is never opened");
  assert.equal(sent.at(-1)?.tps, null);

  service.configure(resolvePet({ enabled: true }));
  tick();
  assert.deepEqual(sent.at(-1)?.tps, { turn: 1, phase: "warmup", value: 70 }, "turned on mid-turn, it still knows the turn");
  const count = sent.length;
  tick();
  assert.equal(sent.length, count, "an unchanged reading sends nothing");

  usage.rows[`${MAIN} ${T1}`] = [row(100, 1100, 3100, 100)];
  appendFileSync(file, `${requestDone()}\n${ended()}\n`);
  clock += PET_TIMING.holdMs;
  tick();
  assert.deepEqual([sent.at(-1)?.mood, sent.at(-1)?.tps], ["done", { turn: 1, phase: "final", value: 50 }]);

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
