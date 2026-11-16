// The desktop pet's main-process side: follows ZCode's log while the pet is shown, takes ZCode's
// card notifications, and pushes the mood and the speed readout whenever they change. Kept free of
// electron imports so it can be tested outside ZCode; main.ts only wires IPC to it.
import { encodePet, resolvePet, type PetAssets, type PetPayload, type ResolvedPet } from "../shared/pet.ts";
import { createMoodStabilizer, createPetTracker, parseLogLine, parsePromptNotification, PET_TIMING, type PetMood } from "../shared/pet-state.ts";
import { createTpsTracker, parseTpsLine, sameTps, type PetTps, type UsageSource } from "../shared/pet-tps.ts";
import { createLogTail } from "./pet-log.ts";

interface PetServiceDeps {
  assets: PetAssets;
  logDir: string;
  /** ZCode's usage rows (pet-usage.ts), read only while the speed readout is on. */
  usage: UsageSource;
  /** Delivers a payload to every page showing the pet. */
  send(payload: PetPayload): void;
  log(message: string): void;
  pollMs?: number;
  now?: () => number;
}

/**
 * Polled in-process while the pet is on: no helper process, nothing written to ZCode's files.
 * Repeated failures are logged once per message.
 */
export function createPetService({ assets, logDir, usage, send, log, pollMs = 500, now = Date.now }: PetServiceDeps) {
  let pet = resolvePet(undefined);
  let mood: PetMood = "idle";
  let tps: PetTps | null = null;
  let running: {
    tracker: ReturnType<typeof createPetTracker>;
    speed: ReturnType<typeof createTpsTracker>;
    stabilize: ReturnType<typeof createMoodStabilizer>;
    poll: () => void;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
  const lastError = { mood: "", tps: "" };

  const payload = () => encodePet(pet, mood, assets, pet.tps ? tps : null);

  /** Logs a failure once, until it changes or that part works again. */
  function failed(part: keyof typeof lastError, error: unknown) {
    if (String(error) !== lastError[part]) log(`pet ${part === "mood" ? "" : "speed readout "}unavailable: ${(lastError[part] = String(error))}`);
  }

  function tick() {
    if (!running) return;
    let nextMood = mood;
    let nextTps = tps;
    try {
      running.poll();
      nextMood = running.stabilize(running.tracker.mood(now()), now());
      lastError.mood = "";
    } catch (error) {
      failed("mood", error);
    }
    // The database is touched only with the readout on; the log is followed for it either way.
    if (pet.tps) {
      try {
        nextTps = running.speed.reading(now(), usage);
        lastError.tps = "";
      } catch (error) {
        nextTps = null;
        failed("tps", error);
      }
    }
    if (nextMood === mood && sameTps(nextTps, tps)) return;
    mood = nextMood;
    tps = nextTps;
    send(payload());
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
    tps = null;
  }

  return {
    /** Applies the resolved settings; starts or stops following the log. */
    configure(next: ResolvedPet) {
      if (JSON.stringify(next) === JSON.stringify(pet)) return;
      pet = next;
      if (!pet.tps) tps = null;
      if (pet.enabled && !running) start();
      if (!pet.enabled && running) stop();
      send(payload());
    },
    /** ZCode's `zcode:show-task-notification` payload, as seen on its way to ZCode's own listener. */
    prompt(raw: unknown) {
      if (!running) return;
      const event = parsePromptNotification(raw);
      if (event) running.tracker.ingest(event, now());
      tick();
    },
    payload,
  };
}
