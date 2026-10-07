// What the desktop pet looks like and how she reacts, shared by both placements: inside ZCode's main
// window (pet.ts) and in Canvas's own desktop window (pet-desktop-page.ts). zcode-fox-widget's fox,
// her bubble and press sounds, plus a mood driven by the runtime. Owned DOM only, in a closed Shadow
// DOM; where the box sits and what a drag moves is up to the placement.
import type { PetMood } from "../shared/pet-state.ts";
import type { PetAssets, ResolvedPet } from "../shared/pet.ts";
import { moodLine, randomLine, type PetLine } from "./pet-quotes.ts";

export interface PetView {
  pet: ResolvedPet;
  mood: PetMood;
  assets: PetAssets;
}

const BUBBLE_MS = 5000;
const DRAG_THRESHOLD = 5;
/** Pixels at or below this alpha let clicks through, as in the fox widget. */
const ALPHA_HIT = 10;
const MASK_SIZE = 152;
/** Moods the pet announces in a bubble. */
const ANNOUNCED: ReadonlySet<PetMood> = new Set(["waiting", "done", "error"]);

const style = `
:host{all:initial}
.pet{position:fixed;left:0;top:0;pointer-events:none;user-select:none;-webkit-user-select:none;font-family:system-ui,"Microsoft YaHei","PingFang SC",sans-serif;
  --fill:#fff;--ink:#203170;--text:#536ba9;transition:transform .3s ease}
:host-context(.dark) .pet{--fill:#2b2b2b;--ink:#d4d4d4;--text:#d4d4d4}
.pet[hidden]{display:none}
.pet.left{transform:scaleX(-1)}
.body{position:absolute;inset:0;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}
.body.pressed{transform:scaleY(.88) scaleX(1.05)}
.figure{position:absolute;right:0;bottom:0;width:59.45%;height:59.45%;transform-origin:50% 100%;pointer-events:none;cursor:grab}
.figure.dragging{cursor:grabbing}
.char{display:block;width:100%;height:100%;pointer-events:none;-webkit-user-drag:none;user-select:none}
.badge{position:absolute;left:2%;top:6%;width:calc(var(--u) * 118);height:calc(var(--u) * 118);border-radius:50%;display:grid;place-items:center;
  font-weight:800;font-size:calc(var(--u) * 78);line-height:1;color:#fff;border:calc(var(--u) * 9) solid var(--fill);box-sizing:border-box;
  opacity:0;transform:scale(.4);transition:opacity .2s ease,transform .25s cubic-bezier(.34,1.56,.64,1);pointer-events:none}
.pet.left .badge{transform:scale(.4) scaleX(-1)}
.pet[data-mood=thinking] .badge{background:#7d90c2}.pet[data-mood=thinking] .badge:after{content:"···";letter-spacing:-.08em}
.pet[data-mood=waiting] .badge{background:#ff8a00}.pet[data-mood=waiting] .badge:after{content:"!"}
.pet[data-mood=done] .badge{background:#f5b400}.pet[data-mood=done] .badge:after{content:"★"}
.pet[data-mood=error] .badge{background:#4aa3ff}.pet[data-mood=error] .badge:after{content:"💧";font-size:calc(var(--u) * 60)}
.pet:is([data-mood=thinking],[data-mood=waiting],[data-mood=done],[data-mood=error]):not(.talking) .badge{opacity:1;transform:none}
.pet.left:is([data-mood=thinking],[data-mood=waiting],[data-mood=done],[data-mood=error]):not(.talking) .badge{transform:scaleX(-1)}
.pet[data-mood=idle] .figure{animation:breathe 3.2s ease-in-out infinite}
.pet[data-mood=thinking] .figure{animation:tilt 2.4s ease-in-out infinite}
.pet[data-mood=working] .figure{animation:bob .5s ease-in-out infinite}
.pet[data-mood=waiting] .figure{animation:hop .9s cubic-bezier(.3,0,.4,1) infinite}
.pet[data-mood=done] .figure{animation:cheer .7s cubic-bezier(.34,1.56,.64,1) 2,breathe 3.2s ease-in-out 1.4s infinite}
.pet[data-mood=error] .figure{animation:shake .5s ease-in-out,droop .4s ease-out .5s forwards}
@keyframes breathe{0%,100%{transform:none}50%{transform:scaleY(1.025)}}
@keyframes tilt{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
@keyframes bob{0%,100%{transform:none}50%{transform:translateY(-3%)}}
@keyframes hop{0%,100%{transform:none}35%{transform:translateY(-9%)}55%{transform:scale(1.04,.96)}}
@keyframes cheer{0%,100%{transform:none}40%{transform:translateY(-14%) scale(.97,1.03)}70%{transform:scale(1.05,.95)}}
@keyframes shake{0%,100%{transform:none}20%,60%{transform:translateX(-4%)}40%,80%{transform:translateX(4%)}}
@keyframes droop{to{transform:translateY(4%) scale(1.02,.96);filter:saturate(.7)}}
@media (prefers-reduced-motion:reduce){.pet .figure{animation:none!important}.body,.badge,.pet{transition:none}}
.bubble{position:absolute;left:0;top:0;width:100%;aspect-ratio:1026/700;pointer-events:none}
.bubble svg{display:block;width:100%;height:100%;pointer-events:none}
.bubble svg :is(path,ellipse){fill:var(--fill);stroke:var(--ink);pointer-events:none;cursor:pointer;opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;transition:opacity .2s ease,transform .2s ease}
.bubble .b2{transition-delay:.3s}.bubble .b1{transition-delay:.2s}.bubble .shape{transition-delay:.1s}
.bubble.open svg :is(path,ellipse){opacity:1;transform:none;pointer-events:visiblePainted}
.bubble.open .b2{transition-delay:0s}.bubble.open .b1{transition-delay:.13s}.bubble.open .shape{transition-delay:.26s}
.text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .16s ease}
.pet.left .text{transform:translate(-50%,-50%) scaleX(-1)}
.bubble.open .text{opacity:1;transition:opacity .16s ease .36s}
.text{text-align:center;color:var(--text);line-height:1.15;white-space:nowrap}
.text.a{font-size:calc(var(--u) * 66);font-weight:600;letter-spacing:.06em;white-space:normal;width:max-content;max-width:calc(var(--u) * 560);line-height:1.2}
.text.b{font-size:calc(var(--u) * 128);font-weight:800;line-height:1.05}
.text[hidden]{display:none}
`;

/** The fox widget's bubble geometry: one large ellipse with a tail and two small bubbles. */
const bubbleMarkup = `<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
<path class="shape" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>
<ellipse class="b1" cx="352" cy="561" rx="37.5" ry="26" stroke-width="18"/>
<ellipse class="b2" cx="442" cy="646" rx="24.5" ry="18" stroke-width="18"/></svg>`;

/** What a drag on the picture does; a press without moving is a click and makes her talk. */
export interface PetDrag {
  start(): void;
  /**
   * Every move once past the threshold, as the pointer's offset from where it went down, in page
   * px (what in-window placement lays out in, whatever ZCode's zoom). In desktop mode the window
   * moves under the pointer, so these stop meaning anything once the drag starts; that placement
   * follows the real cursor in the main process instead.
   */
  move(dx: number, dy: number): void;
  drop(): void;
}

export interface PetDisplay {
  /** Applies settings and mood. False while the pet is off: she is hidden. */
  update(view: PetView): boolean;
  place(left: number, top: number, base: number): void;
  /** Mirrors the pet so she looks to the right (false) or the left (true). */
  face(left: boolean): void;
  /** The picture's own pixels (not its transparent parts) at a viewport point. */
  hits(x: number, y: number): boolean;
  /** An open speech bubble at a viewport point. */
  hitsBubble(x: number, y: number): boolean;
  /** Lets the picture take the pointer at this point only over its own pixels; moves do it already. */
  track(x: number, y: number): void;
  /** The picture's box in viewport coordinates. */
  figureRect(): DOMRect;
  dragging(): boolean;
  dispose(): void;
}

/**
 * Builds the pet inside `host` (which the placement has already put in the document). The only
 * pointer handling here is on the pet's own elements, plus one passive `pointermove` on the window
 * that makes the picture take the pointer only over its non-transparent pixels.
 */
export function createPetDisplay(host: HTMLElement, drag: PetDrag, log: (message: string) => void): PetDisplay {
  const report = (where: string) => (error: unknown) => log(`pet ${where}: ${String(error)}`);
  const guard = <A extends unknown[]>(where: string, action: (...args: A) => void) => (...args: A) => {
    try { action(...args); } catch (error) { report(where)(error); }
  };

  const root = host.attachShadow({ mode: "closed" });
  const sheet = document.createElement("style");
  sheet.textContent = style;
  const pet = document.createElement("div");
  pet.className = "pet";
  pet.dataset.mood = "idle";
  pet.hidden = true;
  // Constant template; lines only ever go through textContent.
  pet.innerHTML = `<div class="body"><div class="figure"><img class="char" alt="" draggable="false"><span class="badge"></span></div></div>
    <div class="bubble">${bubbleMarkup}<div class="text" hidden></div></div>`;
  root.append(sheet, pet);
  const q = <T extends Element>(selector: string) => pet.querySelector(selector) as T;
  const body = q<HTMLElement>(".body"), figure = q<HTMLElement>(".figure"), char = q<HTMLImageElement>(".char");
  const bubble = q<HTMLElement>(".bubble"), text = q<HTMLElement>(".text");
  const press = new Audio(), release = new Audio();

  let view: PetView | null = null;
  let flipped = false;
  let mask: Uint8Array | null = null;
  let maskFor = "";
  let pointer: { x: number; y: number; moved: boolean; id: number } | null = null;
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  let bubbleFrom: "click" | PetMood | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  /** A downscaled alpha channel of the picture; null (whole box clickable) if it cannot be read. */
  function buildMask(url: string) {
    if (maskFor === url) return;
    maskFor = url;
    mask = null;
    const image = new Image();
    image.decoding = "async";
    image.onload = guard("mask", () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = MASK_SIZE;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || maskFor !== url) return;
      context.drawImage(image, 0, 0, MASK_SIZE, MASK_SIZE);
      const pixels = context.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
      const alpha = new Uint8Array(MASK_SIZE * MASK_SIZE);
      for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]!;
      mask = alpha;
      image.removeAttribute("src");
    });
    image.src = url;
  }

  function hits(x: number, y: number): boolean {
    if (pet.hidden) return false;
    const rect = char.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || !rect.width || !rect.height) return false;
    if (!mask) return true;
    let u = (x - rect.left) / rect.width;
    if (flipped) u = 1 - u;
    const v = (y - rect.top) / rect.height;
    const column = Math.min(MASK_SIZE - 1, Math.floor(u * MASK_SIZE));
    const row = Math.min(MASK_SIZE - 1, Math.floor(v * MASK_SIZE));
    return mask[row * MASK_SIZE + column]! > ALPHA_HIT;
  }

  function hitsBubble(x: number, y: number): boolean {
    if (pet.hidden || !bubble.classList.contains("open")) return false;
    const target = root.elementFromPoint(x, y);
    return !!target && bubble.contains(target);
  }

  function play(audio: HTMLAudioElement) {
    if (!view || view.pet.volume <= 0) return;
    audio.volume = view.pet.volume;
    audio.currentTime = 0;
    void audio.play().catch(() => { /* No sound is fine. */ });
  }
  function pressDown() {
    body.classList.add("pressed");
    clearTimeout(releaseTimer);
    play(press);
  }
  /** Short press: the release sound starts 100 ms before the press sound ends; long press: at once. */
  function pressUp() {
    body.classList.remove("pressed");
    const remaining = (press.duration - press.currentTime) * 1000;
    if (!press.paused && !press.ended && Number.isFinite(remaining)) releaseTimer = setTimeout(() => play(release), Math.max(0, remaining - 100));
    else play(release);
  }

  function hideBubble() {
    clearTimeout(bubbleTimer);
    bubble.classList.remove("open");
    pet.classList.remove("talking");
    bubbleFrom = null;
  }
  function showBubble(line: PetLine, from: "click" | PetMood) {
    if (!view?.pet.bubble) return;
    text.textContent = line.text;
    text.className = `text ${line.size === "A" ? "a" : "b"}`;
    text.hidden = false;
    bubble.classList.add("open");
    pet.classList.add("talking");
    bubbleFrom = from;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(guard("bubble", hideBubble), BUBBLE_MS);
  }

  const listeners: Array<() => void> = [];
  const on = (target: EventTarget, name: string, action: (event: Event) => void, options?: AddEventListenerOptions) => {
    const listener = guard(name, action);
    target.addEventListener(name, listener, options);
    listeners.push(() => target.removeEventListener(name, listener, options));
  };
  function track(x: number, y: number) {
    if (!pointer) figure.style.pointerEvents = hits(x, y) ? "auto" : "none";
  }
  on(window, "pointermove", (event) => {
    const e = event as PointerEvent;
    track(e.clientX, e.clientY);
  }, { capture: true, passive: true });
  on(figure, "pointerdown", (event) => {
    const e = event as PointerEvent;
    if (e.button !== 0) return;
    e.preventDefault();
    pointer = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    pressDown();
    try { figure.setPointerCapture(e.pointerId); } catch { /* Synthetic or already released pointer: dragging still works inside the figure. */ }
  });
  on(figure, "pointermove", (event) => {
    const e = event as PointerEvent;
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    if (!pointer.moved) {
      pointer.moved = true;
      figure.classList.add("dragging");
      drag.start();
    }
    drag.move(dx, dy);
  });
  const end = (event: Event) => {
    const e = event as PointerEvent;
    if (!pointer || e.pointerId !== pointer.id) return;
    const moved = pointer.moved;
    pointer = null;
    figure.classList.remove("dragging");
    pressUp();
    if (moved) drag.drop();
    else if (event.type === "pointerup") showBubble(randomLine(), "click");
  };
  on(figure, "pointerup", end);
  on(figure, "pointercancel", end);
  on(bubble, "click", hideBubble);

  function update(next: PetView): boolean {
    const previous = view;
    view = next;
    if (!next.pet.enabled) {
      hideBubble();
      pet.hidden = true;
      return false;
    }
    pet.hidden = false;
    if (char.getAttribute("src") !== next.assets.image) char.src = next.assets.image;
    buildMask(next.assets.image);
    const sounds = next.assets.sounds[next.pet.sound];
    if (press.getAttribute("src") !== sounds.press) press.src = sounds.press;
    if (release.getAttribute("src") !== sounds.release) release.src = sounds.release;
    pet.dataset.mood = next.mood;
    if (!next.pet.bubble) hideBubble();
    if (!previous || previous.mood === next.mood || !previous.pet.enabled) return true;
    // The announcement of a mood that has passed (the question was answered) goes with it.
    if (bubbleFrom !== null && bubbleFrom !== "click" && bubbleFrom !== next.mood) hideBubble();
    // A bubble the user asked for by clicking is never interrupted.
    if (ANNOUNCED.has(next.mood) && bubbleFrom !== "click") {
      const line = moodLine(next.mood);
      if (line) showBubble(line, next.mood);
    }
    return true;
  }

  return {
    update: (next) => {
      try { return update(next); } catch (error) { report("update")(error); return false; }
    },
    place: guard("place", (left: number, top: number, base: number) => {
      const s = pet.style;
      s.width = s.height = `${base}px`;
      s.left = `${left}px`;
      s.top = `${top}px`;
      s.setProperty("--u", `${base / 1026}px`);
    }),
    face: guard("face", (left: boolean) => {
      flipped = left;
      pet.classList.toggle("left", left);
    }),
    hits: (x, y) => { try { return hits(x, y); } catch { return false; } },
    hitsBubble: (x, y) => { try { return hitsBubble(x, y); } catch { return false; } },
    track: guard("track", track),
    figureRect: () => char.getBoundingClientRect(),
    dragging: () => pointer?.moved === true,
    dispose: guard("dispose", () => {
      clearTimeout(bubbleTimer);
      clearTimeout(releaseTimer);
      for (const remove of listeners.splice(0)) remove();
      host.remove();
    }),
  };
}
