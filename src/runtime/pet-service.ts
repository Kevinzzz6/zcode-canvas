// The desktop pet's main-process side: follows ZCode's log while the pet is shown, takes ZCode's
// card notifications, and pushes the mood and the speed readout whenever they change. The mood is
// the same everywhere; the readout is per page, each showing the conversation open in its window.
// Kept free of electron imports so it can be tested outside ZCode; main.ts only wires IPC to it.
import { encodePet, resolvePet, type PetAssets, type PetPayload, type ResolvedPet } from "../shared/pet.ts";
import { createMoodStabilizer, createPetTracker, parseLogLine, parsePromptNotification, PET_TIMING, type PetMood } from "../shared/pet-state.ts";
import { createTpsTracker, parseTpsLine, sameTps, type PetTps, type UsageSource } from "../shared/pet-tps.ts";
import { createLogTail } from "./pet-log.ts";

/** A page that gets the pet's payloads: a ZCode main window's, or the desktop pet's. */
export interface PetPage {
  id: string;
  /** Whether the pet is visible on it, so its readout is worth reading ZCode's usage for. */
  shows: boolean;
  /** The conversation it follows; see TpsViewer in shared/pet-tps.ts. */
  viewing?: string | null;
}

interface PetServiceDeps {
  assets: PetAssets;
  logDir: string;
  /** ZCode's usage rows (pet-usage.ts), read only while the speed readout is on. */
  usage: UsageSource;
  /** Every page that gets payloads, now. */
  pages(): PetPage[];
  /** Delivers a payload to one page. */
  send(page: string, payload: PetPayload): void;
  log(message: string): void;
  pollMs?: number;
  now?: () => number;
}

/**
 * Polled in-process while the pet is on: no helper process, nothing written to ZCode's files.
 * Repeated failures are logged once per message.
 */
export function createPetService({ assets, logDir, usage, pages, send, log, pollMs = 500, now = Date.now }: PetServiceDeps) {
  let pet = resolvePet(undefined);
  let mood: PetMood = "idle";
  /** The reading each page was last sent. */
  const sent = new Map<string, PetTps | null>();
  let running: {
    tracker: ReturnType<typeof createPetTracker>;
    speed: ReturnType<typeof createTpsTracker>;
    stabilize: ReturnType<typeof createMoodStabilizer>;
    poll: () => void;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  const lastError = { mood: "", tps: "" };

  const payload = (page: string) => encodePet(pet, mood, assets, pet.tps ? sent.get(page) ?? null : null);

  function deliver(page: string) {
    try {
      send(page, payload(page));
    } catch (error) {
      log(`pet update failed: ${String(error)}`);
    }
  }

  /** Logs a failure once, until it changes or that part works again. */
  function failed(part: keyof typeof lastError, error: unknown) {
    if (String(error) !== lastError[part]) log(`pet ${part === "mood" ? "" : "speed readout "}unavailable: ${(lastError[part] = String(error))}`);
  }

  function tick() {
    if (!running) return;
    let nextMood = mood;
    try {
      running.poll();
      nextMood = running.stabilize(running.tracker.mood(now()), now());
      lastError.mood = "";
    } catch (error) {
      failed("mood", error);
    }
    const all = pages();
    // The database is touched only with the readout on, and only for pages that show the pet; the
    // log is followed for it either way. A failed read shows nothing rather than an old figure.
    let readings = new Map<string, PetTps | null>();
    if (pet.tps) {
      try {
        readings = running.speed.readings(now(), usage, all.filter((page) => page.shows));
        lastError.tps = "";
      } catch (error) {
        failed("tps", error);
      }
    }
    const moodChanged = nextMood !== mood;
    mood = nextMood;
    const present = new Set<string>();
    for (const page of all) {
      present.add(page.id);
      const next = readings.get(page.id) ?? null;
      const changed = !sameTps(next, sent.get(page.id) ?? null);
      sent.set(page.id, next);
      if (moodChanged || changed) deliver(page.id);
    }
    for (const page of sent.keys()) if (!present.has(page)) sent.delete(page);
  }

  function start() {
    const tracker = createPetTracker();
    const speed = createTpsTracker();
    const tail = createLogTail(logDir, (line) => {
      const event = parseLogLine(line);
      if (event) tracker.ingest(event, now());
      const speedEvent = parseTpsLine(line);
      if (speedEvent) speed.ingest(speedEvent, now());
    });
    const timer = setInterval(tick, pollMs);
    timer.unref?.();
    running = { tracker, speed, stabilize: createMoodStabilizer(PET_TIMING.holdMs), poll: () => tail.poll(), timer };
    tick();
  }

  function stop() {
    if (running) clearInterval(running.timer);
    running = null;
    mood = "idle";
    sent.clear();
  }

  return {
    /** Applies the resolved settings; starts or stops following the log. */
    configure(next: ResolvedPet) {
      if (JSON.stringify(next) === JSON.stringify(pet)) return;
      pet = next;
      if (!pet.tps) sent.clear();
      if (pet.enabled && !running) start();
      if (!pet.enabled && running) stop();
      for (const page of pages()) deliver(page.id);
    },
    /** ZCode's `zcode:show-task-notification` payload, as seen on its way to ZCode's own listener. */
    prompt(raw: unknown) {
      if (!running) return;
      const event = parsePromptNotification(raw);
      if (event) running.tracker.ingest(event, now());
      tick();
    },
    /** A window switched conversations, or another window took focus: update at once. */
    refresh: tick,
    payload,
  };
}
