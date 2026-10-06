// The desktop pet's settings (config.json `pet`) and the payload the runtime sends to the page.
// Pure, no node or DOM imports: the main process, the preload and the panel all use it.
import { PET_MOODS, type PetMood } from "./pet-state.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

export type PetSound = "duck" | "fx1";
export const PET_SOUNDS: readonly PetSound[] = ["duck", "fx1"];

export const PET_SCALE = { min: 0.6, max: 2.5, step: 0.1, fallback: 1.5 } as const;
const PET_VOLUME_FALLBACK = 0.9;

/** config.json `pet`. Not part of the look: themes never carry it and "discard" keeps it. */
export interface PetSpec {
  /** Off unless the user turns it on. */
  enabled?: boolean;
  scale?: number;
  /** 0 mutes. */
  volume?: number;
  sound?: PetSound;
  /** Speech bubbles on click and when the agent needs attention. */
  bubble?: boolean;
}

export interface ResolvedPet {
  enabled: boolean;
  scale: number;
  volume: number;
  sound: PetSound;
  bubble: boolean;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** `canvasEnabled` false (the master switch) hides the pet along with everything else. */
export function resolvePet(spec: unknown, canvasEnabled = true): ResolvedPet {
  const own = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as PetSpec) : {};
  return {
    enabled: canvasEnabled && own.enabled === true,
    scale: Math.round(clamp(own.scale, PET_SCALE.min, PET_SCALE.max, PET_SCALE.fallback) * 10) / 10,
    volume: clamp(own.volume, 0, 1, PET_VOLUME_FALLBACK),
    sound: PET_SOUNDS.includes(own.sound as PetSound) ? (own.sound as PetSound) : "duck",
    bubble: own.bubble !== false,
  };
}

/** A panel request's `pet` field, checked field by field; throws on anything the panel would not send. */
export function parsePetPatch(raw: unknown): PetSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid pet request");
  const patch: PetSpec = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((key === "enabled" || key === "bubble") && typeof value === "boolean") patch[key] = value;
    else if (key === "scale" && typeof value === "number" && value >= PET_SCALE.min && value <= PET_SCALE.max) patch.scale = value;
    else if (key === "volume" && typeof value === "number" && value >= 0 && value <= 1) patch.volume = value;
    else if (key === "sound" && PET_SOUNDS.includes(value as PetSound)) patch.sound = value as PetSound;
    else throw new Error(`invalid pet ${key}`);
  }
  return patch;
}

/** file: URLs of the pet's bundled assets, resolved by the main process. */
export interface PetAssets {
  image: string;
  rua: string;
  sounds: Record<PetSound, { press: string; release: string }>;
}

export interface PetPayload {
  v: number;
  pet: ResolvedPet;
  mood: PetMood;
  assets: PetAssets;
}

export function encodePet(pet: ResolvedPet, mood: PetMood, assets: PetAssets): PetPayload {
  return { v: PROTOCOL_VERSION, pet, mood, assets };
}

/** Null for anything but the current protocol: a newer main is ignored until ZCode restarts. */
export function decodePet(payload: unknown): Omit<PetPayload, "v"> | null {
  if (!payload || typeof payload !== "object") return null;
  const { v, pet, mood, assets } = payload as Partial<PetPayload>;
  if (v !== PROTOCOL_VERSION || !pet || !assets || !PET_MOODS.includes(mood as PetMood)) return null;
  return { pet: resolvePet(pet), mood: mood as PetMood, assets };
}
