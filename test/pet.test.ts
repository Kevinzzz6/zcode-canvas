import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogTail, zcodeLogDir, zcodeLogFile } from "../src/runtime/pet-log.ts";
import { createPetService } from "../src/runtime/pet-service.ts";
import { snapPosition } from "../src/runtime/pet.ts";
import { decodePet, encodePet, parsePetPatch, resolvePet, type PetPayload } from "../src/shared/pet.ts";
import { createMoodStabilizer, createPetTracker, parseLogLine, parsePromptNotification, PET_TIMING, PROMPT_SHOWN } from "../src/shared/pet-state.ts";

const MAIN = "sess_143ad587-8312-4016-b752-befbcc65d8df";
const AGENT = "agent_e8e21487-0a8c-461a-b387-3c47da3edb48";
const PERM = "perm_1e0bb7fa-6c3e-4e1f-8c33-69096d995186";

/** Shaped like ZCode 3.14.4's ~/.zcode/cli/log lines, trimmed to the fields that matter. */
function line(event: string, fields: Record<string, unknown> = {}, context: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: "2026-10-06T09:39:43.978Z", level: "info", event, module: "core.runtime", sessionId: MAIN, turnId: "turn_1", ...fields, context: { turnNumber: 0, ...context } });
}
const tool = (event: string, id: string, toolName: string, extra: Record<string, unknown> = {}) =>
  line(event, { toolCallId: id, status: event.split(".").at(-1), ...extra }, { querySource: "main_turn", toolName });
const resolved = (requestId: string, decision = "allow", fields: Record<string, unknown> = {}) =>
  line("tool.permission.resolved", { toolCallId: "toolu_q", status: decision === "deny" ? "failed" : "completed", ...fields }, { querySource: "main_turn", toolName: "Bash", decision, requestId });
/** ZCode's zcode:show-task-notification payload for a card. */
const card = (requestId: string, status = "permission_request", taskId = MAIN) => ({ taskId, status, requestId, title: "ZCode", body: "需要你确认" });

function run(lines: string[], start = 0) {
  const tracker = createPetTracker();
  let now = start;
  for (const text of lines) {
    const event = parseLogLine(text);
    if (event) tracker.ingest(event, now);
    now += 10;
  }
  const show = (payload: unknown, at = now) => tracker.ingest(parsePromptNotification(payload)!, at);
  const feed = (text: string, at = now) => tracker.ingest(parseLogLine(text)!, at);
  return { tracker, now, show, feed };
}

test("log lines become events; noise and broken lines are skipped", () => {
  assert.deepEqual(parseLogLine(tool("tool.call.started", "toolu_1", "Read")), {
    event: "tool.call.started", sessionId: MAIN, toolCallId: "toolu_1", status: "started", agentId: undefined, querySource: "main_turn", requestId: undefined,
  });
  assert.equal(parseLogLine(resolved(PERM))?.requestId, PERM);
  assert.equal(parseLogLine(line("session.event.persistence.started")), null);
  assert.equal(parseLogLine(line("model.request.completed", {}, { toolCallCount: 1 })), null);
  assert.equal(parseLogLine('{"event":"turn.started","sessionId":'), null);
  assert.equal(parseLogLine(JSON.stringify({ event: "turn.started" })), null);
});

test("only question and approval cards count as prompts", () => {
  assert.deepEqual(parsePromptNotification(card(PERM)), { event: PROMPT_SHOWN, sessionId: MAIN, requestId: PERM });
  assert.equal(parsePromptNotification(card(PERM, "elicitation_request"))?.requestId, PERM);
  assert.equal(parsePromptNotification({ taskId: MAIN, status: "elicitation_request" })?.requestId, MAIN, "a card without id is keyed by its session");
  for (const other of ["completed", "failed", "feedback_update"]) assert.equal(parsePromptNotification(card(PERM, other)), null);
  for (const bad of [null, "x", [], { status: "permission_request" }, { taskId: "", status: "permission_request" }]) assert.equal(parsePromptNotification(bad), null);
});

test("a turn moves through thinking, working and done, then calms down", () => {
  const { tracker, feed } = run([]);
  feed(line("turn.started", { status: "started" }), 0);
  assert.equal(tracker.mood(0), "thinking");
  feed(line("model.request.started", { status: "started" }, { querySource: "main_turn" }), 10);
  assert.equal(tracker.mood(10), "thinking");
  feed(tool("tool.call.started", "a", "Bash"), 20);
  feed(tool("tool.call.started", "b", "Read"), 21);
  assert.equal(tracker.mood(30), "working");
  feed(tool("tool.call.completed", "a", "Bash"), 40);
  assert.equal(tracker.mood(40), "working");
  feed(tool("tool.call.failed", "b", "Read"), 50);
  assert.equal(tracker.mood(50), "thinking", "a failed tool call is not a failed turn");
  feed(line("turn.completed", { status: "completed" }), 60);
  assert.equal(tracker.mood(60), "done");
  assert.equal(tracker.mood(60 + PET_TIMING.resultMs - 1), "done");
  assert.equal(tracker.mood(60 + PET_TIMING.resultMs), "idle");
});

test("a card waits for the user until ZCode logs its resolution, answered or denied", () => {
  for (const decision of ["allow", "modify", "deny"]) {
    const { tracker, show, feed, now } = run([line("turn.started")]);
    show(card(PERM, decision === "modify" ? "elicitation_request" : "permission_request"));
    assert.equal(tracker.mood(now), "waiting", "at once, no delay");
    const later = now + PET_TIMING.staleMs + 1;
    assert.equal(tracker.mood(later), "waiting", "a card may wait longer than a silent turn lives");
    feed(resolved(PERM, decision), later);
    assert.equal(tracker.mood(later), "idle", `${decision}: the card is gone, and the silent turn expired meanwhile`);
    feed(tool("tool.call.started", "q", "Bash"), later);
    assert.equal(tracker.mood(later), "working", "the answered tool reopens the turn");
  }
});

test("waiting beats running tools; slow tools or hooks alone never mean waiting", () => {
  const { tracker, show, feed, now } = run([line("turn.started"), tool("tool.call.started", "a", "Bash")]);
  assert.equal(tracker.mood(now + 60_000), "working", "a slow tool or PreToolUse hook is just work");
  show(card(PERM));
  assert.equal(tracker.mood(now), "waiting", "a card next to a running tool is not hidden by it");
  feed(tool("tool.call.completed", "a", "Bash"));
  assert.equal(tracker.mood(now), "waiting", "another tool finishing does not answer the card");
  feed(resolved(PERM));
  assert.equal(tracker.mood(now), "thinking");
});

test("queued cards and repeated reports: waiting lasts until every card is answered", () => {
  const second = "perm_66b5fb5c-0842-41d2-b4ae-c24391874b33";
  const { tracker, show, feed, now } = run([line("turn.started")]);
  show(card(PERM));
  show(card(PERM), now + 5_000);
  show(card(second));
  feed(resolved(PERM));
  assert.equal(tracker.mood(now), "waiting");
  feed(resolved(second));
  assert.equal(tracker.mood(now), "thinking");

  const repeated = run([]);
  repeated.show(card(PERM));
  repeated.show(card(PERM), repeated.now + 5_000);
  assert.equal(repeated.tracker.mood(repeated.now + PET_TIMING.promptStaleMs + 1), "idle", "a second report does not restart the card's clock");
});

test("cards outside the permission flow end when their session moves on", () => {
  const { tracker, show, feed, now } = run([line("turn.started"), tool("tool.call.started", "m", "mcp__server__tool")]);
  show(card("elicit_7", "elicitation_request"));
  show(card(PERM, "permission_request", "sess_other"));
  feed(line("model.request.started", { sessionId: "sess_other" }, { querySource: "main_turn" }));
  assert.equal(tracker.mood(now), "waiting", "another session's activity answers nothing");
  feed(tool("tool.call.completed", "m", "mcp__server__tool"));
  feed(resolved(PERM, "allow", { sessionId: "sess_other" }));
  assert.equal(tracker.mood(now), "thinking");
});

test("a turn that ends drops its cards; stopping it by hand is not an error", () => {
  const cancelled = run([line("turn.started")]);
  cancelled.show(card(PERM));
  cancelled.feed(line("turn.failed", { level: "error", status: "cancelled" }));
  assert.equal(cancelled.tracker.mood(cancelled.now), "idle");
  const failed = run([line("turn.started")]);
  failed.show(card(PERM));
  failed.feed(line("turn.failed", { level: "error", status: "failed" }));
  assert.equal(failed.tracker.mood(failed.now), "error");
  const forgotten = run([]);
  forgotten.show(card(PERM));
  assert.equal(forgotten.tracker.mood(forgotten.now + PET_TIMING.promptStaleMs + 1), "idle");
});

test("sessions merge by urgency: a waiting card beats an error beats work", () => {
  const other = { sessionId: "sess_other" };
  const { tracker, show, feed, now } = run([
    line("turn.started", other), line("tool.call.started", { ...other, toolCallId: "x" }, { querySource: "main_turn", toolName: "Bash" }),
    line("turn.started"), line("turn.completed"),
  ]);
  assert.equal(tracker.mood(now), "working", "another session still works after this one is done");
  feed(line("turn.failed", { sessionId: "sess_third", status: "failed" }));
  assert.equal(tracker.mood(now), "error");
  show(card(PERM, "permission_request", "sess_fourth"));
  assert.equal(tracker.mood(now), "waiting");
});

test("subagents count as work, but their own turns never announce done or error", () => {
  const child = { sessionId: `sess_subagent_${AGENT}` };
  const { tracker, now, feed } = run([
    line("turn.started", child),
    line("tool.call.started", { ...child, toolCallId: "c" }, { querySource: "subagent", toolName: "Read", agentId: AGENT }),
  ]);
  assert.equal(tracker.mood(now), "working");
  feed(line("turn.completed", child));
  assert.equal(tracker.mood(now), "idle");

  const background = run([line("model.request.started", child, { querySource: "subagent", agentId: AGENT })]);
  assert.equal(background.tracker.mood(background.now), "thinking", "joining mid-turn still notices running agents");
  background.feed(line("subagent.background.completed", {}, { agentId: AGENT }));
  assert.equal(background.tracker.mood(background.now), "idle");
});

test("requests outside a turn (titles, summaries) and stale turns never leave the pet busy", () => {
  const side = run([line("model.request.started", {}, { querySource: "session_title" })]);
  assert.equal(side.tracker.mood(side.now), "idle");
  const stuck = run([line("turn.started"), tool("tool.call.started", "a", "Bash")]);
  assert.equal(stuck.tracker.mood(stuck.now + PET_TIMING.staleMs + 1), "idle");
});

test("calm moods are held long enough not to flicker; attention moods show at once", () => {
  const stabilize = createMoodStabilizer(1500);
  assert.equal(stabilize("thinking", 0), "thinking");
  assert.equal(stabilize("working", 500), "thinking");
  assert.equal(stabilize("working", 1500), "working");
  assert.equal(stabilize("thinking", 1600), "working");
  assert.equal(stabilize("waiting", 1700), "waiting");
  assert.equal(stabilize("done", 1800), "done");
  assert.equal(stabilize("idle", 2000), "done");
  assert.equal(stabilize("idle", 3300), "idle");
});

test("a dropped pet snaps to the edges whose outer quarter holds its center, axis by axis", () => {
  // Window 1000×800, box 200: free space 800 across and 800 - 32 - 200 = 568 down (title bar kept clear).
  assert.deepEqual(snapPosition(50, 600, 200, 1000, 800), { x: 0, y: 1 }, "bottom-left corner");
  assert.deepEqual(snapPosition(780, 40, 200, 1000, 800), { x: 1, y: 0 }, "top-right corner");
  assert.deepEqual(snapPosition(400, 316, 200, 1000, 800), { x: 0.5, y: 0.5 }, "free in the middle");
  assert.deepEqual(snapPosition(400, 600, 200, 1000, 800), { x: 0.5, y: 1 }, "axes snap independently");
  assert.deepEqual(snapPosition(0, 32, 300, 250, 300), { x: 1, y: 1 }, "no free space: stays at the default corner");
});

test("the service follows the log only while the pet is on and pushes every change", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-pet-service-"));
  const file = zcodeLogFile(dir, new Date());
  writeFileSync(file, `${line("turn.started")}\n`);
  const sent: PetPayload[] = [];
  let clock = 0;
  const assets = { image: "file:///a.png", sounds: { duck: { press: "file:///1", release: "file:///2" }, fx1: { press: "file:///3", release: "file:///4" } } };
  const service = createPetService({ assets, logDir: dir, send: (payload) => sent.push(payload), log: () => {}, pollMs: 60_000, now: () => clock });
  service.prompt(card(PERM));
  assert.equal(sent.length, 0, "an off pet ignores cards");
  service.configure(resolvePet({ enabled: true }));
  assert.deepEqual(sent.map((payload) => [payload.pet.enabled, payload.mood]), [[true, "idle"]], "history before turning on is skipped");
  service.prompt(card(PERM));
  assert.equal(sent.at(-1)?.mood, "waiting", "a card shows without waiting for the next poll");
  appendFileSync(file, `${resolved(PERM)}\n`);
  clock += PET_TIMING.holdMs;
  service.prompt(null);
  assert.equal(sent.at(-1)?.mood, "idle");
  service.configure(resolvePet({ enabled: true }));
  assert.equal(sent.length, 3, "unchanged settings send nothing");
  service.configure(resolvePet({ enabled: false }));
  assert.deepEqual([sent.at(-1)?.pet.enabled, service.payload().mood], [false, "idle"]);
});

test("pet settings default to off and are clamped; the master switch hides the pet", () => {
  assert.deepEqual(resolvePet(undefined), { enabled: false, scale: 1.5, volume: 0.9, sound: "duck", bubble: true, desktop: false });
  assert.deepEqual(resolvePet({ enabled: true, scale: 9, volume: -1, sound: "loud", bubble: false }), { enabled: true, scale: 2.5, volume: 0, sound: "duck", bubble: false, desktop: false });
  assert.equal(resolvePet({ enabled: true }, false).enabled, false);
  assert.equal(resolvePet({ scale: 1.23 }).scale, 1.2);
  assert.equal(resolvePet("on").enabled, false);
});

test("panel pet requests are checked field by field", () => {
  assert.deepEqual(parsePetPatch({ enabled: true, scale: 1, volume: 0, sound: "fx1", bubble: false }), { enabled: true, scale: 1, volume: 0, sound: "fx1", bubble: false });
  for (const bad of [null, [], { enabled: "yes" }, { scale: 3 }, { volume: 2 }, { sound: "x" }, { image: "C:/x.png" }]) assert.throws(() => parsePetPatch(bad));
});

test("the pet payload round-trips and ignores a newer protocol", () => {
  const assets = { image: "file:///a.png", sounds: { duck: { press: "file:///1", release: "file:///2" }, fx1: { press: "file:///3", release: "file:///4" } } };
  const pet = resolvePet({ enabled: true });
  assert.deepEqual(decodePet(encodePet(pet, "waiting", assets)), { pet, mood: "waiting", assets });
  assert.equal(decodePet({ ...encodePet(pet, "idle", assets), v: 2 }), null);
  assert.equal(decodePet({ ...encodePet(pet, "idle", assets), mood: "dancing" }), null);
  assert.equal(decodePet(null), null);
});

test("the log lives where ZCode writes it, one file per local day", () => {
  assert.equal(zcodeLogDir({ ZCODE_LOG_DIR: "/tmp/logs" }), "/tmp/logs");
  assert.match(zcodeLogDir({}), /[\\/]\.zcode[\\/]cli[\\/]log$/);
  assert.equal(zcodeLogFile("/d", new Date(2026, 0, 5, 23, 59)), join("/d", "zcode-2026-01-05.jsonl"));
});

test("the tail skips history, hands over complete lines only, and follows a new day", () => {
  const dir = mkdtempSync(join(tmpdir(), "zc-pet-log-"));
  const day1 = new Date(2026, 9, 6, 23, 59);
  const day2 = new Date(2026, 9, 7, 0, 1);
  const lines: string[] = [];
  const tail = createLogTail(dir, (text) => lines.push(text));
  tail.poll(day1);
  writeFileSync(zcodeLogFile(dir, day1), "old 1\nold 2\n");
  tail.poll(day1);
  assert.deepEqual(lines, ["old 1", "old 2"], "a file created after the first look is read from its start");

  const later = createLogTail(dir, (text) => lines.push(`later:${text}`));
  later.poll(day1);
  appendFileSync(zcodeLogFile(dir, day1), "new 1\nhalf");
  later.poll(day1);
  assert.deepEqual(lines.slice(2), ["later:new 1"], "history is skipped and a half-written line waits");
  appendFileSync(zcodeLogFile(dir, day1), " line\n");
  writeFileSync(zcodeLogFile(dir, day2), "next day\n");
  later.poll(day2);
  assert.deepEqual(lines.slice(2), ["later:new 1", "later:half line", "later:next day"]);
  writeFileSync(zcodeLogFile(dir, day2), "new\n");
  later.poll(day2);
  assert.equal(lines.at(-1), "later:new", "a file that shrank is reread from the start");
  later.poll(day2);
  assert.equal(lines.length, 6);
});

test("a missing log directory is not an error", () => {
  const tail = createLogTail(join(tmpdir(), "zc-pet-log-missing", String(Date.now())), () => assert.fail("no lines"));
  tail.poll();
  tail.poll();
});
