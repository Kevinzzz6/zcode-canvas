// The save strip of the appearance panel: shown while personal overrides exist, it keeps them as a
// theme (in place or as a new one) or drops them. Kept apart from overlay.ts, which only wires it in.
import type { PanelData } from "./panel.ts";

/** Constant markup; theme names only ever go through textContent and value. */
export const studioMarkup = `<div id="studio" class="studio" role="group" aria-label="保存修改" hidden>
  <span id="studio-label" class="studio-label"></span>
  <input id="studio-name" class="studio-name" maxlength="60" autocomplete="off" aria-label="新主题名称" hidden>
  <button id="studio-save" class="text-button">保存</button><button id="studio-save-as" class="text-button">另存为…</button><button id="studio-discard" class="text-button" title="删除所有个人调整，包括壁纸选择，回到主题原样">丢弃</button><button id="studio-cancel" class="text-button" hidden>取消</button>
</div>`;

export interface StudioDeps {
  $: <T extends HTMLElement = HTMLElement>(id: string) => T;
  listen(target: EventTarget, name: string, action: (event: Event) => void | Promise<unknown>): void;
  mutate(action: () => Promise<unknown>, message: string): Promise<void>;
  saveTheme(request: { name?: string }): Promise<unknown>;
  discard(): Promise<unknown>;
  data(): PanelData | undefined;
}

export function mountStudio({ $, listen, mutate, saveTheme, discard, data }: StudioDeps): { render(): void } {
  const bar = $("studio"), label = $("studio-label"), name = $<HTMLInputElement>("studio-name");
  const save = $("studio-save"), saveAs = $("studio-save-as"), drop = $("studio-discard"), cancel = $("studio-cancel");
  let naming = false;
  let armed: ReturnType<typeof setTimeout> | undefined;
  const theme = () => { const d = data(); return d?.themes.find((entry) => entry.id === d.config.theme); };
  function disarm() { clearTimeout(armed); armed = undefined; drop.textContent = "丢弃"; }
  function render() {
    const d = data();
    bar.hidden = !d || d.config.enabled === false || !d.unsaved;
    if (bar.hidden) { naming = false; disarm(); return; }
    const current = theme();
    label.textContent = `${current?.name ?? "原生"} · 有未保存的修改`;
    for (const element of [label, saveAs, drop]) element.hidden = naming;
    name.hidden = cancel.hidden = !naming;
    // Built-in themes are replaced by every `apply`, so they can only be saved as a new theme.
    save.hidden = !naming && (!current || current.builtin);
    save.title = naming ? "保存为新主题" : `把修改写进「${current?.name ?? ""}」，原文件留作 theme.json.bak`;
  }
  function setNaming(on: boolean) {
    naming = on;
    disarm();
    render();
    if (!on) return saveAs.focus();
    name.value = theme() ? `${theme()!.name} 自定义` : "我的主题";
    name.focus(); name.select();
  }
  function saveNew() {
    const value = name.value.trim();
    if (!value) return name.focus();
    naming = false;
    return mutate(() => saveTheme({ name: value }), `已另存为主题「${value}」`);
  }
  listen(save, "click", () => naming ? saveNew() : mutate(() => saveTheme({}), `已保存到「${theme()?.name ?? ""}」`));
  listen(saveAs, "click", () => setNaming(true));
  listen(cancel, "click", () => setNaming(false));
  listen(name, "keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "Enter" && e.key !== "Escape") return;
    // Escape leaves naming only; it must not also close the panel.
    e.preventDefault(); e.stopPropagation();
    return e.key === "Enter" ? saveNew() : setNaming(false);
  });
  // Discarding also drops the wallpaper choice, so it takes a second click.
  listen(drop, "click", () => {
    if (!armed) {
      drop.textContent = "确认丢弃";
      armed = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    return mutate(discard, "已丢弃修改 · 回到主题原样");
  });
  return { render };
}
