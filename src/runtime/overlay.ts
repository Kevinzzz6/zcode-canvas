import type { PanelData, PanelInput } from "./panel.ts";
import { overlayStyle } from "./overlay-style.ts";
import { diagnose, displayNumber, formatKnob, fromSlider, inputKey, knobRangeText, knobs, knobValue, parseKnobInput, SLIDER_SPAN, stepKnob, toSlider, trackFraction, type Knob, type Size } from "./overlay-preview.ts";
import type { WallpaperFit } from "../shared/look.ts";

export interface OverlayApi {
  get(): Promise<PanelData>;
  apply(input: PanelInput): Promise<unknown>;
  selectWallpaper(id: string): Promise<unknown>;
  pickWallpaper(): Promise<{ canceled: boolean }>;
  preview(input: PanelInput): Promise<void>;
  clearPreview(): void;
  log(message: string): void;
}

const PREF_KEY = "zcode-canvas:entry:v1";
type Preferences = { hidden: boolean; side: "left" | "right"; y: number | null; seen: boolean };
const defaults = (): Preferences => ({ hidden: false, side: "right", y: null, seen: false });
const POSITION_HINT = "位置按图片和窗口的剩余空间对齐；填满时会调整裁切。";
const paletteIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5H18A3 3 0 0 0 21 12a9 9 0 0 0-9-9Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="11" cy="6.8" r=".8"/><circle cx="15.5" cy="8" r=".8"/></svg>';

function pickerColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((digit) => digit + digit).join("").toLowerCase()}`;
  const rgb = /^rgb\(([^)]+)\)$/i.exec(color);
  if (!rgb) return null;
  const channels = rgb[1]?.split(/[\s,]+/).filter(Boolean) ?? [];
  if (channels.length !== 3 || channels.some((channel) => !/^\d{1,3}(?:\.\d+)?$/.test(channel))) return null;
  const values = channels.map(Number);
  if (values.some((channel) => channel < 0 || channel > 255)) return null;
  return `#${values.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** Isolated, owned DOM only. No global bridge, host selectors, polling, or notification observer. */
export function mountOverlay(api: OverlayApi): { open(): void; refresh(): void } {
  const host = document.createElement("zcode-canvas-overlay");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = overlayStyle + ".entry,.panel,.menu{pointer-events:auto}";
  root.append(style);
  const shell = document.createElement("div");
  shell.className = "canvas-shell";
  // This template is constant. User filenames, theme names and errors only ever use textContent.
  shell.innerHTML = `
    <button class="entry" aria-label="外观 · 主题与壁纸" aria-expanded="false" aria-controls="panel">${paletteIcon}</button>
    <section id="panel" class="panel" role="dialog" aria-label="外观" hidden>
      <header><div class="brand">${paletteIcon}</div><div><h1>外观</h1><div class="sub">CANVAS</div></div><div class="spacer"></div>
        <button class="icon" id="options" aria-label="更多选项" aria-haspopup="true">···</button>
        <button class="icon" id="close" aria-label="关闭外观面板"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg></button></header>
      <div class="content">
        <div class="label">主题<span id="theme-custom" class="custom-tag" hidden>已自定义</span><span class="spacer"></span><small>独立配色，随选随用</small></div><div class="themes" id="themes"></div>
        <div class="label wallpaper-heading">我的壁纸<small id="count"></small><span class="spacer"></span><button id="pick" class="text-button">＋ 添加图片</button></div>
        <div class="library" id="library" aria-label="壁纸库"></div>
        <div class="current"><span id="current"></span><button id="clear" class="text-button" title="清除个人壁纸覆盖，恢复主题自带壁纸">恢复主题壁纸</button></div>
        <div class="tuning"><div class="label compact">常用调节</div><div id="primary-knobs"></div><div id="primary-hint" class="hint notice" role="note" hidden></div>
          <div id="overlay-notice" class="overlay-notice" hidden>旧遮罩正在生效 <button id="clear-overlay" class="text-button">清除遮罩</button></div>
          <details id="theme-details"><summary>主题细节<span id="theme-detail-custom" class="custom-tag" hidden>已自定义</span></summary><div id="theme-knobs"></div>
            <label class="select-row">强调色<span class="spacer"></span><small id="accent-current" class="accent-current"></small><input type="color" id="accent" aria-label="强调色"></label>
            <label class="select-row" id="material-row">原生材质<select id="material" aria-label="原生材质"><option value="none">无</option><option value="acrylic">亚克力</option><option value="mica">云母</option><option value="tabbed">标签云母</option></select></label>
            <div id="material-hint" class="hint" role="note" hidden></div>
            <button id="reset-theme" class="text-button" title="恢复主题默认外观，保留当前壁纸">恢复主题默认</button>
          </details>
          <details id="wallpaper-details"><summary>壁纸细节<span id="wallpaper-custom" class="custom-tag" hidden>已自定义</span></summary><div id="wallpaper-knobs"></div>
            <label class="select-row">铺放方式<select id="fit" aria-label="铺放方式"><option value="cover">填满</option><option value="contain">适应</option><option value="fill">拉伸</option><option value="center">居中</option><option value="tile">平铺</option></select></label>
            <div id="wallpaper-hint" class="hint" role="note"></div>
            <button id="center-position" class="text-button" title="将水平和垂直位置恢复到 50%">居中图片</button>
            <button id="reset-tuning" class="text-button">重置壁纸调节</button>
          </details>
        </div>
      </div>
      <footer><span class="dot"></span><span id="status" role="status" aria-live="polite">即点即用 · 所有窗口同步</span><kbd>Esc</kbd></footer>
    </section>
    <div class="menu" id="menu" role="menu" hidden></div>`;
  root.append(shell);
  document.documentElement.append(host);
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => root.getElementById(id) as T;
  const entry = root.querySelector<HTMLButtonElement>(".entry")!;
  const panel = $("panel");
  const menu = $("menu");
  let prefs = defaults();
  let data: PanelData | undefined;
  let previousFocus: HTMLElement | null = null;
  let busy = false;
  let revision = 0;
  let draggingSlider = false;
  let pending: PanelInput = {};
  let activeSlider: HTMLInputElement | null = null;
  let entryDrag: { x: number; y: number; moved: boolean } | null = null;
  let suppressClick = false;
  let librarySignature = "";
  const frozen = new Map<string, string>();
  let transient = "";
  const values = {} as Record<Knob, number>;
  /** Natural image sizes by URL; null = unmeasurable (e.g. an SVG without intrinsic size). */
  const imageSizes = new Map<string, Size | null>();
  const report = (error: unknown) => {
    api.log(String(error));
    $("status").textContent = "暂时无法完成操作，请重试";
  };
  const safe = (action: () => void | Promise<unknown>) => () => {
    try { Promise.resolve(action()).catch(report); } catch (error) { report(error); }
  };
  function listen(target: EventTarget, name: string, action: (event: Event) => void | Promise<unknown>) {
    target.addEventListener(name, (event) => safe(() => action(event))());
  }
  function readPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
      prefs = saved ? { hidden: saved.hidden === true, side: saved.side === "left" ? "left" : "right",
        y: typeof saved.y === "number" && Number.isFinite(saved.y) ? Math.min(1, Math.max(0, saved.y)) : null, seen: saved.seen === true } : defaults();
    } catch { prefs = defaults(); }
  }
  function savePreferences() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (error) { api.log(`entry preferences: ${String(error)}`); }
  }
  function position() {
    const y = Math.max(44, Math.min(innerHeight - 84, prefs.y === null ? innerHeight - 260 : prefs.y * innerHeight));
    entry.style.top = `${y}px`;
    entry.style.bottom = "auto";
    entry.style.left = prefs.side === "left" ? "10px" : "auto";
    entry.style.right = prefs.side === "right" ? "10px" : "auto";
    entry.dataset.side = prefs.side;
    entry.hidden = prefs.hidden;
    entry.dataset.intro = String(!prefs.seen);
    if (!panel.hidden) {
      panel.style.maxHeight = `${Math.max(120, innerHeight - 64)}px`;
      const width = Math.min(400, innerWidth - 24);
      const gutter = prefs.hidden ? 16 : entry.offsetWidth + 20;
      const left = prefs.side === "right" ? innerWidth - width - gutter : gutter;
      panel.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, left))}px`;
      panel.style.top = `${Math.max(32, Math.min(y + 40 - panel.offsetHeight, innerHeight - panel.offsetHeight - 32))}px`;
      panel.style.transformOrigin = `${prefs.side === "right" ? "right" : "left"} bottom`;
    }
  }
  function dismiss(restoreFocus: boolean) {
    if (panel.hidden && menu.hidden) return;
    if (Object.keys(pending).length) safe(commitPending)();
    panel.hidden = true;
    menu.hidden = true;
    entry.setAttribute("aria-expanded", "false");
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  async function refresh() {
    if (panel.hidden || busy || draggingSlider) return;
    const request = ++revision;
    const next = await api.get();
    if (request !== revision || busy || draggingSlider) return;
    data = next;
    render();
  }
  async function open() {
    if (!panel.hidden) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== host) previousFocus = document.activeElement;
    panel.hidden = false;
    menu.hidden = true;
    entry.setAttribute("aria-expanded", "true");
    prefs.seen = true;
    savePreferences();
    position();
    $("close").focus({ preventScroll: true });
    await refresh();
    root.querySelector<HTMLElement>(".tile[aria-pressed=true]")?.scrollIntoView({ block: "nearest" });
  }
  function setBusy(value: boolean) {
    busy = value;
    panel.setAttribute("aria-busy", String(value));
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(".content button,.content input,.content select")) control.disabled = value;
  }
  async function mutate(action: () => Promise<unknown>, message: string | ((data: PanelData) => string)) {
    if (busy) return;
    ++revision;
    setBusy(true);
    $("status").textContent = "正在应用…";
    let committed = false;
    try {
      const result = await action();
      committed = true;
      data = await api.get();
      transient = result && typeof result === "object" && "canceled" in result && result.canceled ? "已取消选择"
        : typeof message === "function" ? message(data) : message;
    } catch (error) {
      transient = committed ? "已应用，列表暂时无法刷新" : "未能应用，已恢复已保存的外观";
      api.log(String(error));
      try { data = await api.get(); } catch (readError) { api.log(String(readError)); }
    } finally {
      api.clearPreview();
      setBusy(false);
      if (data) render();
      $("status").textContent = transient;
    }
  }
  async function commitPending(message = "已应用 · 所有窗口同步") {
    const patch = pending;
    pending = {};
    draggingSlider = false;
    activeSlider = null;
    if (Object.keys(patch).length) await mutate(() => api.apply(patch), message);
  }
  function mode() { return document.documentElement.classList.contains("dark") ? "dark" : "light"; }
  /** The value the theme gives this control, i.e. what "恢复默认" returns to. */
  function defaultOf(key: Knob): number {
    return data ? knobValue(data.defaults, data.defaults.wallpaper[mode()], key) : knobs[key].fallback;
  }
  function syncReset(key: Knob) {
    const reset = $<HTMLButtonElement>(`${key}-reset`);
    const fallback = defaultOf(key);
    reset.disabled = busy || $<HTMLInputElement>(key).disabled || Math.abs(values[key] - fallback) < knobs[key].step / 2;
    reset.title = `恢复默认 ${formatKnob(key, fallback)}`;
    $(`${key}-track`).style.setProperty("--default", String(trackFraction(key, fallback)));
    $(`${key}-track`).title = `默认 ${formatKnob(key, fallback)}`;
  }
  function updateKnob(key: Knob, value: number) {
    const input = $<HTMLInputElement>(key);
    input.value = String(toSlider(key, value));
    input.style.setProperty("--fill", `${100 * trackFraction(key, value)}%`);
    input.setAttribute("aria-valuetext", formatKnob(key, value));
    $(`${key}-value`).textContent = formatKnob(key, value);
    values[key] = value;
    syncReset(key);
  }
  /** Preview one control's new value; the caller commits it (release, Enter, keyboard step). */
  function stage(key: Knob, value: number) {
    if (key === "transparency") pending.glassOpacity = Number((1 - value / 100).toFixed(4));
    else if (key === "positionX" || key === "positionY") {
      pending.positionX = key === "positionX" ? value : values.positionX;
      pending.positionY = key === "positionY" ? value : values.positionY;
    }
    else (pending as Record<string, unknown>)[key] = value;
    updateKnob(key, value);
    if (key === "transparency" || key === "scale" || key === "blur") updateHints();
    if (data && data.config.enabled !== false) void api.preview({ ...pending }).catch(report);
  }
  function measure(url: string | null | undefined): Size | null {
    if (!url) return null;
    if (imageSizes.has(url)) return imageSizes.get(url)!;
    imageSizes.set(url, null);
    const probe = new Image();
    probe.decoding = "async";
    probe.onload = () => {
      imageSizes.set(url, probe.naturalWidth > 0 && probe.naturalHeight > 0 ? { width: probe.naturalWidth, height: probe.naturalHeight } : null);
      probe.removeAttribute("src");
      safe(updateHints)();
    };
    probe.onerror = () => probe.removeAttribute("src");
    probe.src = url;
    return null;
  }
  /** Disable controls that cannot work right now and say why, right next to them. */
  function updateHints() {
    if (!data || busy) return;
    const off = data.config.enabled === false;
    const wallpaper = data.effective.wallpaper[mode()];
    const { disabled, hints } = diagnose({
      wallpaper, transparency: values.transparency, fit: $<HTMLSelectElement>("fit").value as WallpaperFit,
      scale: values.scale, blur: values.blur, image: measure(data.imageUrl?.[mode()]),
      viewport: { width: innerWidth, height: innerHeight },
    });
    for (const key of Object.keys(knobs) as Knob[]) {
      const reason = disabled[key];
      $<HTMLInputElement>(key).disabled = off || reason !== undefined;
      $<HTMLButtonElement>(`${key}-value`).disabled = off || reason !== undefined;
      $(`${key}-row`).title = reason ?? "";
      syncReset(key);
    }
    const show = (id: string, text: string | null) => { $(id).textContent = text ?? ""; $(id).hidden = !text; };
    show("primary-hint", hints.primary);
    show("material-hint", data.platform === "win32" ? hints.material : null);
    show("wallpaper-hint", hints.wallpaper ?? POSITION_HINT);
  }
  for (const key of Object.keys(knobs) as Knob[]) {
    const spec = knobs[key];
    const curved = "curve" in spec;
    const row = document.createElement("div");
    row.className = "knob"; row.id = `${key}-row`;
    const label = document.createElement("label");
    label.textContent = spec.label; label.htmlFor = key;
    const track = document.createElement("span"); track.className = "track"; track.id = `${key}-track`;
    const input = document.createElement("input");
    input.type = "range"; input.id = key;
    input.min = curved ? "0" : String(spec.min); input.max = curved ? String(SLIDER_SPAN) : String(spec.max); input.step = curved ? "1" : String(spec.step);
    input.setAttribute("aria-label", spec.label);
    track.append(input);
    const cell = document.createElement("span"); cell.className = "value-cell";
    const valueButton = document.createElement("button");
    valueButton.type = "button"; valueButton.className = "value"; valueButton.id = `${key}-value`;
    valueButton.setAttribute("aria-label", `${spec.label}：输入数值`); valueButton.title = "点击输入数值";
    const editor = document.createElement("input");
    editor.className = "value-edit"; editor.id = `${key}-edit`; editor.hidden = true; editor.inputMode = "decimal"; editor.autocomplete = "off";
    editor.setAttribute("aria-label", `${spec.label}数值，范围 ${knobRangeText(key)}`);
    cell.append(valueButton, editor);
    const reset = document.createElement("button");
    reset.type = "button"; reset.className = "knob-reset"; reset.id = `${key}-reset`; reset.textContent = "↺"; reset.disabled = true;
    reset.setAttribute("aria-label", `${spec.label}恢复默认`);
    row.append(label, track, cell, reset);
    $(`${spec.group}-knobs`).append(row);
    listen(valueButton, "click", () => {
      editor.value = String(displayNumber(key, values[key]));
      valueButton.hidden = true; editor.hidden = false;
      editor.focus(); editor.select();
    });
    const finishEdit = async (commit: boolean, refocus: boolean) => {
      if (editor.hidden) return;
      editor.hidden = true; valueButton.hidden = false;
      if (refocus) valueButton.focus({ preventScroll: true });
      if (!commit) return;
      const parsed = parseKnobInput(key, editor.value);
      if (!parsed) { $("status").textContent = `请输入数字，范围 ${knobRangeText(key)}`; return; }
      if (Math.abs(parsed.value - values[key]) < spec.step / 2) return;
      stage(key, parsed.value);
      await commitPending(parsed.clamped ? `已限制在 ${knobRangeText(key)}` : undefined);
    };
    listen(editor, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.key !== "Enter" && e.key !== "Escape") return;
      // Escape cancels the edit only; it must not also close the panel.
      e.preventDefault(); e.stopPropagation();
      return finishEdit(e.key === "Enter", true);
    });
    listen(editor, "blur", () => finishEdit(true, false));
    listen(reset, "click", () => mutate(() => api.apply({ unset: [inputKey(key)] }), `${spec.label}已恢复默认`));
    listen(input, "pointerdown", (event) => {
      draggingSlider = true; activeSlider = input;
      input.setPointerCapture((event as PointerEvent).pointerId);
    });
    listen(input, "input", () => {
      activeSlider = input;
      stage(key, fromSlider(key, Number(input.value)));
    });
    // Curved tracks step in the value's own unit, not in track positions.
    if (curved) listen(input, "keydown", (event) => {
      const e = event as KeyboardEvent;
      const direction = ({ ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 } as Record<string, number>)[e.key];
      const next = e.key === "Home" ? spec.min : e.key === "End" ? spec.max
        : direction ? stepKnob(key, values[key], direction, e.shiftKey || e.key.startsWith("Page")) : null;
      if (next === null) return;
      e.preventDefault();
      stage(key, next);
      return commitPending();
    });
    listen(input, "change", () => commitPending());
    listen(input, "pointerup", () => { draggingSlider = false; return commitPending(); });
    listen(input, "pointercancel", () => { draggingSlider = false; return commitPending(); });
    listen(input, "blur", () => { if (activeSlider === input) return commitPending(); });
  }
  function render() {
    if (!data) return;
    const themes = $("themes");
    const wanted = [{ id: "", name: "原生", swatch: { background: "#292c34", accent: "#a2a9b8" } }, ...data.themes];
    // Keep controls and focus stable across global watcher updates.
    if (themes.dataset.signature !== JSON.stringify(wanted)) {
      themes.dataset.signature = JSON.stringify(wanted);
      themes.replaceChildren();
      for (const item of wanted) {
        const button = document.createElement("button"); button.className = "theme"; button.dataset.id = item.id;
        button.title = item.name; button.setAttribute("aria-label", `主题：${item.name}`);
        const swatch = document.createElement("span"); swatch.className = "swatch";
        swatch.style.background = item.swatch.background; swatch.style.setProperty("--swatch-accent", item.swatch.accent);
        const name = document.createElement("span"); name.className = "theme-name"; name.textContent = item.name;
        button.append(swatch, name);
        listen(button, "click", () => mutate(() => api.apply({ theme: item.id || null }), `已切换为${item.name}`));
        themes.append(button);
      }
    }
    for (const button of themes.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.id === (data.config.theme ?? "")));
    const library = $("library");
    const signature = JSON.stringify(data.wallpapers);
    if (librarySignature !== signature) {
      librarySignature = signature;
      library.replaceChildren();
      for (const item of data.wallpapers) {
        const button = document.createElement("button"); button.className = "tile"; button.dataset.id = item.id; button.title = item.name;
        button.setAttribute("aria-label", `壁纸：${item.name}`);
        const img = document.createElement("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.width = 240; img.height = 166;
        if (item.animated && !frozen.has(item.url)) {
          listen(img, "load", () => {
            if (!img.isConnected) return;
            try {
              const canvas = document.createElement("canvas");
              const scale = Math.min(240 / img.naturalWidth, 166 / img.naturalHeight);
              canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
              canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
              const context = canvas.getContext("2d");
              if (!context) throw new Error("thumbnail canvas unavailable");
              context.drawImage(img, 0, 0, canvas.width, canvas.height);
              frozen.set(item.url, canvas.toDataURL("image/png"));
              // Replace, then release the animated image's resource. No animated thumbnails remain.
              img.replaceWith(canvas); img.removeAttribute("src");
            } catch (error) {
              img.removeAttribute("src"); img.remove();
              button.textContent = "GIF";
              api.log(`thumbnail: ${String(error)}`);
            }
          });
        }
        listen(img, "error", () => { img.remove(); const text = document.createElement("span"); text.className = "broken"; text.textContent = "预览不可用"; button.append(text); });
        img.src = frozen.get(item.url) ?? item.url;
        button.append(img);
        listen(button, "click", () => mutate(() => api.selectWallpaper(item.id), (next) =>
          next.effective.glass.opacity >= 1 ? "已换上壁纸 · 界面不透明，调高「界面透明」后可见" : "已换上壁纸 · 所有窗口同步"));
        library.append(button);
      }
      if (!data.wallpapers.length) {
        const empty = document.createElement("div"); empty.className = "empty";
        const title = document.createElement("strong"); title.textContent = "留一个位置，给喜欢的风景";
        empty.append(title, "添加自己的图片，在这里随时切换。"); library.append(empty);
      }
    }
    for (const button of library.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.id === data.wallpaper.id));
    $("count").textContent = `${data.wallpapers.length} 张`;
    const current = data.wallpaper.file ?? (data.wallpaper.fromTheme ? "主题自带壁纸" : "未设置壁纸");
    $("current").textContent = current; $("current").title = current;
    $<HTMLButtonElement>("clear").hidden = !data.config.wallpaper;
    const wallpaper = data.effective.wallpaper[mode()];
    for (const key of Object.keys(knobs) as Knob[]) updateKnob(key, knobValue(data.effective, wallpaper, key));
    $<HTMLSelectElement>("fit").value = wallpaper?.fit ?? "cover";
    updateHints();
    $<HTMLSelectElement>("fit").disabled = !wallpaper || data.config.enabled === false;
    $("theme-custom").hidden = !data.overrides?.theme;
    $("theme-detail-custom").hidden = !data.overrides?.theme;
    $("wallpaper-custom").hidden = !data.overrides?.wallpaper;
    $<HTMLButtonElement>("reset-theme").disabled = !data.overrides?.theme || data.config.enabled === false;
    $<HTMLButtonElement>("reset-tuning").disabled = !data.overrides?.wallpaper || data.config.enabled === false;
    $("material-row").hidden = data.platform !== "win32";
    $<HTMLSelectElement>("material").value = data.effective.glass.material;
    $<HTMLSelectElement>("material").disabled = data.config.enabled === false;
    const colors = data.effective.colors[mode()];
    const accent = [colors.primary, colors["--color-primary"], data.effective.accent[mode()],
      getComputedStyle(document.documentElement).getPropertyValue("--color-primary")]
      .map(pickerColor).find((color) => color !== null) ?? null;
    const accentInput = $<HTMLInputElement>("accent");
    accentInput.value = accent ?? "#000000";
    accentInput.classList.toggle("unknown", !accent);
    accentInput.title = accent ? `当前强调色 ${accent}` : "当前颜色随主题；选择颜色即可覆盖";
    $("accent-current").textContent = accent ? accent.toUpperCase() : "随主题";
    accentInput.disabled = data.config.enabled === false;
    $<HTMLButtonElement>("center-position").disabled = !wallpaper || data.config.enabled === false;
    $("overlay-notice").hidden = !wallpaper || wallpaper.dim <= 0;
    $<HTMLButtonElement>("clear-overlay").disabled = data.config.enabled === false;
    $("status").textContent = data.config.enabled === false ? "Canvas 当前已禁用，请在配置中启用" : "即点即用 · 所有窗口同步";
    position();
  }
  function showMenu(anchor: HTMLElement) {
    const wasOpen = !menu.hidden; menu.hidden = true;
    if (wasOpen) return;
    menu.replaceChildren();
    const add = (text: string, action: () => void | Promise<unknown>) => {
      const button = document.createElement("button"); button.textContent = text; button.setAttribute("role", "menuitem");
      listen(button, "click", () => { menu.hidden = true; return action(); }); menu.append(button);
    };
    add(prefs.hidden ? "显示入口" : "隐藏入口", () => {
      prefs.hidden = !prefs.hidden; savePreferences(); position();
      $("status").textContent = prefs.hidden ? "入口已隐藏 · 快捷键或托盘仍可打开" : "入口已显示";
    });
    add("重置位置", () => { prefs.side = "right"; prefs.y = null; savePreferences(); position(); });
    menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(innerWidth - menu.offsetWidth - 12, rect.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(32, Math.min(innerHeight - menu.offsetHeight - 32, rect.bottom + 6))}px`;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }
  listen(entry, "click", () => { if (suppressClick) { suppressClick = false; return; } if (panel.hidden) return open(); dismiss(true); });
  listen(entry, "contextmenu", (event) => { event.preventDefault(); showMenu(entry); });
  listen(entry, "pointerdown", (event) => {
    const e = event as PointerEvent;
    if (e.button !== 0) return;
    suppressClick = false;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== host) previousFocus = document.activeElement;
    entryDrag = { x: e.clientX, y: e.clientY, moved: false }; entry.setPointerCapture(e.pointerId);
  });
  listen(entry, "pointermove", (event) => {
    if (!entryDrag) return;
    const e = event as PointerEvent;
    if (Math.hypot(e.clientX - entryDrag.x, e.clientY - entryDrag.y) > 5) entryDrag.moved = true;
    if (!entryDrag.moved) return;
    prefs.side = e.clientX < innerWidth / 2 ? "left" : "right";
    prefs.y = Math.max(44, Math.min(innerHeight - 84, e.clientY - 20)) / innerHeight;
    position();
  });
  const endDrag = () => { if (entryDrag?.moved) { suppressClick = true; savePreferences(); } entryDrag = null; };
  listen(entry, "pointerup", endDrag); listen(entry, "pointercancel", endDrag);
  listen($("options"), "click", () => showMenu($("options")));
  listen($("close"), "click", () => dismiss(true));
  listen($("pick"), "click", () => mutate(() => api.pickWallpaper(), (next) =>
    next.effective.glass.opacity >= 1 ? "壁纸库已更新 · 界面不透明，调高「界面透明」后可见" : "壁纸库已更新"));
  listen($("clear"), "click", () => mutate(() => api.apply({ wallpaper: null }), "已恢复主题壁纸"));
  listen($("fit"), "change", () => mutate(() => api.apply({ fit: $<HTMLSelectElement>("fit").value }), "已更新铺放方式"));
  listen($("accent"), "change", () => {
    const accent = $<HTMLInputElement>("accent").value;
    return mutate(() => api.apply({ accent }), "已更新强调色");
  });
  listen($("material"), "change", () => mutate(() => api.apply({ material: $<HTMLSelectElement>("material").value }), "已更新原生材质"));
  listen($("reset-theme"), "click", () => mutate(() => api.apply({ reset: "theme" }), "已重置主题调节"));
  listen($("reset-tuning"), "click", () => mutate(() => api.apply({ reset: "wallpaper" }), "已重置壁纸调节"));
  listen($("center-position"), "click", () => mutate(() => api.apply({ positionX: 50, positionY: 50 }), "图片已居中"));
  listen($("clear-overlay"), "click", () => mutate(() => api.apply({ clearOverlay: true }), "已清除遮罩"));
  listen($("theme-details"), "toggle", position);
  listen($("wallpaper-details"), "toggle", position);
  listen(window, "resize", () => { menu.hidden = true; position(); updateHints(); });
  listen(window, "storage", (event) => { if ((event as StorageEvent).key === PREF_KEY) { readPreferences(); position(); } });
  listen(document, "pointerdown", (event) => {
    if (draggingSlider || entryDrag || event.composedPath().includes(host)) return;
    dismiss(false);
  });
  listen(document, "keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Escape" && (!panel.hidden || !menu.hidden)) {
      e.preventDefault(); e.stopPropagation();
      if (!menu.hidden) { menu.hidden = true; (panel.hidden ? entry : $("options")).focus(); }
      else dismiss(true);
    }
  });
  listen(root, "pointerdown", (event) => {
    const path = event.composedPath();
    if (!menu.hidden && !path.includes(menu) && !path.includes($("options")) && !path.includes(entry)) menu.hidden = true;
  });
  // Keystrokes within our controls never bubble to the editor. Outside Canvas nothing is captured.
  listen(root, "keydown", (event) => {
    const e = event as KeyboardEvent;
    e.stopPropagation();
    if (!menu.hidden && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(root.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!menu.hidden) { menu.hidden = true; (panel.hidden ? entry : $("options")).focus(); }
      else dismiss(true);
    }
    if (e.key === "Tab" && !panel.hidden) {
      const scope = menu.hidden ? panel : menu;
      const focusable = [...scope.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary")].filter((el) => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  readPreferences(); position();
  const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘⌥⇧O" : "Ctrl+Alt+Shift+O";
  entry.title = `外观 · ${shortcut}\n拖动调整位置，右键隐藏或重置`;
  listen(window, "pagehide", () => { api.clearPreview(); host.remove(); });
  return { open: safe(open), refresh: safe(refresh) };
}
