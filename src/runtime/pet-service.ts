// The desktop pet's main-process side: follows ZCode's log while the pet is shown, takes ZCode's
// card notifications, and pushes the mood whenever it changes. Kept free of electron imports so it
// can be tested outside ZCode; main.ts only wires IPC to it.
import { encodePet, resolvePet, type PetAssets, type PetPayload, type ResolvedPet } from "../shared/pet.ts";
import { createMoodStabilizer, createPetTracker, parseLogLine, parsePromptNotification, PET_TIMING, type PetMood } from "../shared/pet-state.ts";
import { createLogTail } from "./pet-log.ts";

interface PetServiceDeps {
  assets: PetAssets;
  logDir: string;
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
export function createPetService({ assets, logDir, send, log, pollMs = 500, now = Date.now }: PetServiceDeps) {
  let pet = resolvePet(undefined);
  let mood: PetMood = "idle";
  let running: { tracker: ReturnType<typeof createPetTracker>; stabilize: ReturnType<typeof createMoodStabilizer>; poll: () => void; timer: ReturnType<typeof setInterval> } | null = null;
  let lastError = "";

  const payload = () => encodePet(pet, mood, assets);

  function tick() {
    if (!running) return;
    try {
      running.poll();
      const next = running.stabilize(running.tracker.mood(now()), now());
      lastError = "";
      if (next === mood) return;
      mood = next;
      send(payload());
    } catch (error) {
      if (String(error) !== lastError) log(`pet unavailable: ${(lastError = String(error))}`);
    }
  }

  function start() {
    const tracker = createPetTracker();
    const tail = createLogTail(logDir, (line) => {
      const event = parseLogLine(line);
      if (event) tracker.ingest(event, now());
    });
    const timer = setInterval(tick, pollMs);
    timer.unref?.();
    running = { tracker, stabilize: createMoodStabilizer(PET_TIMING.holdMs), poll: () => tail.poll(), timer };
    tick();
  }

  function stop() {
    if (running) clearInterval(running.timer);
    running = null;
    mood = "idle";
  }

  return {
    /** Applies the resolved settings; starts or stops following the log. */
    configure(next: ResolvedPet) {
      if (JSON.stringify(next) === JSON.stringify(pet)) return;
      pet = next;
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
