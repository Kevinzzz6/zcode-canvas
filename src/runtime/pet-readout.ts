// The speed readout in the pet's bubble (shared/pet-tps.ts): "≈ 48 tok/s" over a five-pip power
// meter while the agent writes, its waves rippling faster the faster she goes; once the turn is over
// the waves straighten into "= 48.3" and a seal is stamped on it; once her line about it is over,
// the freed room shows how long first tokens took ("首字 2.3 s"). Above it, a small tag names the
// project and model when the figure is not the conversation open in this window. Owned DOM in the
// pet's closed Shadow DOM, styled by pet-display.ts's sheet; text only ever goes through textContent.
import type { PetTps, TpsPhase } from "../shared/pet-tps.ts";
import { speedTier, speedWord, WARMUP_WORD } from "./pet-quotes.ts";

// Sizes are in --u, 1/1026 of the pet's box, like the bubble's. The sign's two strokes share one
// path shape (C then S) in every state, so the browser can morph ≈ into = (CSS `d`).
const WAVE = ["M6 18C14 8 22 8 30 18S46 28 54 18", "M6 38C14 28 22 28 30 38S46 48 54 38"];
const SWELL = ["M6 18C14 28 22 28 30 18S46 8 54 18", "M6 38C14 48 22 48 30 38S46 28 54 38"];
const FLAT = ["M6 18C14 18 22 18 30 18S46 18 54 18", "M6 38C14 38 22 38 30 38S46 38 54 38"];
const d = (path: string) => `d:path("${path}")`;

/** One color per pip, cool to warm, after her periwinkle eyes and blush; a tier takes its top pip's. */
const PIPS = ["#a3acd6", "#7b9cf2", "#45b4ee", "#ffa25a", "#ff7096"];
const RAINBOW = "linear-gradient(100deg,#ff7096,#ffa25a,#45b4ee,#7b9cf2,#ff7096)";
const levels = [1, 2, 3, 4, 5];
const lit = levels.map((n) => `.tps[data-level="${n}"] .pips i:nth-child(-n+${n})`).join(",");
const top = levels.map((n) => `.tps[data-phase=live][data-level="${n}"] .pips i:nth-child(${n})`).join(",");

export const readoutStyle = `
.tps{--tier:color-mix(in srgb,var(--text),transparent 40%);--off:color-mix(in srgb,var(--text),transparent 84%);
  display:flex;flex-direction:column;align-items:center;gap:calc(var(--u) * 22);color:var(--text);line-height:1;
  font-family:ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold",system-ui,"Microsoft YaHei","PingFang SC",sans-serif}
.tps[hidden]{display:none}
${PIPS.map((color, tier) => `.tps[data-tier="${tier}"]{--tier:${color}}`).join("")}.tps[data-tier="5"]{--tier:${PIPS[4]}}
.tps .row{position:relative;display:flex;align-items:baseline;gap:calc(var(--u) * 12)}
.tps .sign{align-self:center;width:calc(var(--u) * 84);height:calc(var(--u) * 78);flex:none;color:var(--tier);overflow:visible;transition:color .4s ease}
.tps .sign path{fill:none;stroke:currentColor;stroke-width:8.5;stroke-linecap:round;transition:d .8s cubic-bezier(.34,1.8,.5,1)}
.tps .s1{${d(WAVE[0]!)}}.tps .s2{${d(WAVE[1]!)}}
.tps:not([data-phase=final]) .s1{animation:swell1 var(--dur,1.4s) ease-in-out infinite}
.tps:not([data-phase=final]) .s2{animation:swell2 var(--dur,1.4s) ease-in-out infinite;animation-delay:calc(var(--dur,1.4s) * -.15)}
@keyframes swell1{50%{${d(SWELL[0]!)}}}
@keyframes swell2{50%{${d(SWELL[1]!)}}}
.tps[data-phase=final] .s1{${d(FLAT[0]!)}}.tps[data-phase=final] .s2{${d(FLAT[1]!)}}
.tps .num{font-size:calc(var(--u) * 150);font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums;transition:opacity .3s ease}
.tps[data-phase=warmup] .num{opacity:.42}
.tps:is([data-tier="4"],[data-tier="5"]):not([data-phase=warmup]) .num{background:linear-gradient(100deg,#ff7096,#ffa25a);-webkit-background-clip:text;background-clip:text;color:transparent}
.tps .unit{font-size:calc(var(--u) * 46);font-weight:700;opacity:.5}
.tps .dots{display:none;align-self:center;gap:calc(var(--u) * 16);padding:0 calc(var(--u) * 10);height:calc(var(--u) * 150);align-items:center}
.tps .dots i{width:calc(var(--u) * 26);height:calc(var(--u) * 26);border-radius:50%;background:currentColor;opacity:.4;animation:hop-dot 1.1s ease-in-out infinite}
.tps .dots i:nth-child(2){animation-delay:.15s}.tps .dots i:nth-child(3){animation-delay:.3s}
@keyframes hop-dot{0%,60%,100%{transform:none;opacity:.4}30%{transform:translateY(-55%);opacity:1}}
.tps.empty .num,.tps.empty .unit{display:none}.tps.empty .dots{display:flex}
.tps .meter{display:flex;align-items:center;gap:calc(var(--u) * 20)}
.tps .pips{display:flex;gap:calc(var(--u) * 9)}
.tps .pips i{display:block;width:calc(var(--u) * 44);height:calc(var(--u) * 23);border-radius:99px;background:var(--off);transform:scale(.82);
  transition:background-color .3s ease calc(var(--n) * 70ms),transform .45s cubic-bezier(.34,1.8,.5,1) calc(var(--n) * 70ms)}
${PIPS.map((color, n) => `.tps .pips i:nth-child(${n + 1}){--n:${n};--c:${color}}`).join("")}
${lit}{background:var(--c);transform:none}
${top}{animation:glow 1.2s ease-in-out infinite}
@keyframes glow{50%{opacity:.4}}
.tps[data-phase=warmup] .pips i{animation:scan 1.5s ease-in-out infinite;animation-delay:calc(var(--n) * .15s)}
@keyframes scan{0%,55%,100%{background:var(--off);transform:scale(.82)}22%{background:color-mix(in srgb,var(--text),transparent 50%);transform:none}}
.tps[data-tier="5"] .pips i{background:${RAINBOW};background-size:500% 100%;transform:none;animation:rainbow 1.4s linear infinite;animation-delay:calc(var(--n) * -.14s)}
@keyframes rainbow{to{background-position:100% 0}}
.tps[data-phase=final]:not([data-tier="5"]) .pips i{animation:flash .6s ease-out both;animation-delay:calc(.3s + var(--n) * 60ms)}
@keyframes flash{45%{transform:scale(1.3);filter:brightness(1.2)}}
.tps .word{display:inline-block;white-space:nowrap;font-size:calc(var(--u) * 50);font-weight:900;letter-spacing:.06em;color:var(--tier);transform:skewX(-8deg);transition:color .4s ease}
.tps[data-tier="5"] .word{background:${RAINBOW};background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent}
.tps .seal{position:absolute;left:calc(100% - var(--u) * 112);top:calc(var(--u) * -10);display:none;padding:calc(var(--u) * 8) calc(var(--u) * 14);white-space:nowrap;
  font-size:calc(var(--u) * 34);font-weight:900;letter-spacing:.14em;color:#ec5b7a;background:var(--fill);border:calc(var(--u) * 5) solid currentColor;border-radius:calc(var(--u) * 14);
  box-shadow:inset 0 0 0 calc(var(--u) * 4) var(--fill),inset 0 0 0 calc(var(--u) * 7) currentColor;transform:rotate(-14deg)}
.tps[data-phase=final] .seal{display:block;animation:stamp .55s cubic-bezier(.3,1.6,.5,1) .4s both}
@keyframes stamp{0%{transform:scale(2.6) rotate(-34deg);opacity:0}55%{opacity:1}100%{transform:rotate(-14deg);opacity:1}}
.tps .spark{position:absolute;display:none;font-style:normal;color:#ffc83d;pointer-events:none}
.tps .k1{left:calc(var(--u) * 70);top:calc(var(--u) * -56);font-size:calc(var(--u) * 46)}
.tps .k2{right:calc(var(--u) * 60);bottom:calc(var(--u) * -30);font-size:calc(var(--u) * 32);color:var(--tier)}
.tps .k3{left:calc(var(--u) * -14);bottom:calc(var(--u) * -6);font-size:calc(var(--u) * 28)}
.tps[data-phase=final] .spark{display:block;animation:twinkle .9s ease-out both}
.tps[data-phase=final] .k1{animation-delay:.2s}.tps[data-phase=final] .k2{animation-delay:.32s}.tps[data-phase=final] .k3{animation-delay:.44s}
@keyframes twinkle{0%{transform:scale(0) rotate(0);opacity:0}35%{transform:scale(1.2) rotate(25deg);opacity:1}100%{transform:scale(.5) rotate(60deg) translateY(-40%);opacity:0}}
.tps .src{display:flex;align-items:center;gap:calc(var(--u) * 10);max-width:calc(var(--u) * 540);padding:calc(var(--u) * 7) calc(var(--u) * 20) calc(var(--u) * 7) calc(var(--u) * 14);
  border-radius:999px;background:color-mix(in srgb,var(--text),transparent 88%);font-size:calc(var(--u) * 38);font-weight:700;white-space:nowrap}
.tps .src[hidden]{display:none}
.tps .src svg{flex:none;width:calc(var(--u) * 40);height:calc(var(--u) * 34);fill:var(--tier);transition:fill .4s ease}
.tps .who{overflow:hidden;text-overflow:ellipsis;opacity:.85}
.tps .who b{font-weight:700;opacity:.6}
.tps:has(.src:not([hidden])){gap:calc(var(--u) * 14)}
.tps:has(.src:not([hidden])) .num{font-size:calc(var(--u) * 128)}.tps:has(.src:not([hidden])) .dots{height:calc(var(--u) * 128)}
.tps .extra{display:none;align-items:center;gap:calc(var(--u) * 10);font-size:calc(var(--u) * 40);font-weight:700;font-variant-numeric:tabular-nums;opacity:.7}
.tps .extra svg{width:calc(var(--u) * 40);height:calc(var(--u) * 40);fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
.tps .extra b{font-weight:700;opacity:.65}
.say:not(.both) .tps[data-phase=final] .extra:not([hidden]){display:flex;animation:settle .45s cubic-bezier(.34,1.56,.64,1) both}
@keyframes settle{0%{transform:translateY(-30%);opacity:0}100%{transform:none;opacity:.7}}
.say.both .tps{gap:calc(var(--u) * 14)}
.say.both .tps .num{font-size:calc(var(--u) * 106)}.say.both .tps .sign{width:calc(var(--u) * 62);height:calc(var(--u) * 58)}
.say.both .tps .unit{font-size:calc(var(--u) * 36)}.say.both .tps .dots{height:calc(var(--u) * 106)}
.say.both .tps .pips i{width:calc(var(--u) * 32);height:calc(var(--u) * 17)}.say.both .tps .word{font-size:calc(var(--u) * 40)}
.say.both .text.a{font-size:calc(var(--u) * 58)}
.say.both .tps .seal{position:static;align-self:center;margin-left:calc(var(--u) * 6)}
@media (prefers-reduced-motion:reduce){.tps *{animation:none!important;transition:none!important}}
`;

/** A stopwatch, for the wait before first tokens. */
const stopwatch = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="11.5" r="6.8"/><path d="M10 11.5V8M8 2.6h4M15.3 5.6l1.2-1.2"/></svg>`;

/** A folder, the tag's mark: rounded like the rest of her bubble. */
const folder = `<svg viewBox="0 0 20 17" aria-hidden="true"><path d="M2.5 1h5.2c.6 0 1.1.3 1.5.7L10.4 3H17.5A2.5 2.5 0 0 1 20 5.5v9A2.5 2.5 0 0 1 17.5 17h-15A2.5 2.5 0 0 1 0 14.5v-11A2.5 2.5 0 0 1 2.5 1z"/></svg>`;

const markup = `<div class="src" hidden>${folder}<span class="who"></span></div><div class="row"><svg class="sign" viewBox="0 0 60 56"><path class="s1"/><path class="s2"/></svg><span class="num"></span><span class="dots"><i></i><i></i><i></i></span><span class="unit">tok/s</span>
<span class="seal">实测</span><i class="spark k1">✦</i><i class="spark k2">✦</i><i class="spark k3">✦</i></div>
<div class="meter"><span class="pips"><i></i><i></i><i></i><i></i><i></i></span><span class="word"></span></div>
<div class="extra" hidden>${stopwatch}<span class="waited"></span></div>`;

/** An estimate shows whole numbers (tenths below 10); the exact figure tenths below 100. */
export function formatTps(value: number, phase: TpsPhase): string {
  return value < (phase === "final" ? 100 : 10) ? value.toFixed(1) : String(Math.round(value));
}

/** "2.3 s", or whole seconds from 10 on. */
export function formatWait(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** Seconds per ripple of the ≈: quicker the faster she writes, a step per doubling. */
const ripple = (value: number) => Math.max(0.35, Math.min(1.8, 1.8 - 0.35 * Math.log2(Math.max(value, 20) / 20)));

const COUNT_MS = 650;

export function createReadout() {
  const element = document.createElement("div");
  element.className = "tps";
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  // Constant template; figures and words only ever go through textContent.
  element.innerHTML = markup;
  const num = element.querySelector(".num") as HTMLElement;
  const word = element.querySelector(".word") as HTMLElement;
  const src = element.querySelector(".src") as HTMLElement;
  const who = element.querySelector(".who") as HTMLElement;
  const extra = element.querySelector(".extra") as HTMLElement;
  const waited = element.querySelector(".waited") as HTMLElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let shown: PetTps | null = null;
  /** The figure on screen, mid-count included. */
  let current = 0;
  let frame = 0;

  /** Counts up (or down) to the new figure, like a speedometer settling. */
  function count(from: number, to: number, phase: TpsPhase) {
    cancelAnimationFrame(frame);
    if (still.matches || from === to) {
      current = to;
      num.textContent = formatTps(to, phase);
      return;
    }
    const start = performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - start) / COUNT_MS);
      current = progress < 1 ? from + (to - from) * (1 - (1 - progress) ** 3) : to;
      num.textContent = formatTps(current, phase);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function show(reading: PetTps | null) {
    if (!reading) {
      cancelAnimationFrame(frame);
      element.hidden = true;
      shown = null;
      return;
    }
    const fresh = shown?.turn !== reading.turn;
    const { value, phase } = reading;
    element.hidden = false;
    element.dataset.phase = phase;
    element.classList.toggle("empty", value === null);
    // While warming up nothing of this turn is measured: the meter scans instead of showing a tier.
    const tier = value === null || phase === "warmup" ? null : speedTier(value);
    if (tier === null) delete element.dataset.tier;
    else element.dataset.tier = String(tier);
    element.dataset.level = String(tier === null ? 0 : Math.min(5, tier + 1));
    word.textContent = tier === null ? WARMUP_WORD : speedWord(value!);
    // Shown by the stylesheet only on a final figure, once her line has made room.
    extra.hidden = reading.wait === undefined && !reading.buffered;
    if (reading.buffered) waited.replaceChildren("含等待");
    else if (reading.wait !== undefined) {
      const label = document.createElement("b");
      label.textContent = "首字 ";
      waited.replaceChildren(label, formatWait(reading.wait));
    }
    src.hidden = !reading.source;
    if (reading.source) {
      // "project · model", the model dimmed; either alone when the other is unknown.
      const { project, model } = reading.source;
      const part = (text: string, dim: boolean) => { const node = document.createElement(dim ? "b" : "span"); node.textContent = text; return node; };
      who.replaceChildren(...(project ? [part(project, false)] : []), ...(project && model ? [part(" · ", true)] : []), ...(model ? [part(model, !!project)] : []));
    }
    if (value !== null) {
      element.style.setProperty("--dur", `${ripple(value).toFixed(2)}s`);
      // A new turn revs up from zero; an update counts on from where the figure stands.
      if (fresh || shown?.value !== value || shown?.phase !== phase) count(fresh || shown?.value === null ? 0 : current, value, phase);
    }
    shown = reading;
  }

  return { element, show, dispose: () => cancelAnimationFrame(frame) };
}
