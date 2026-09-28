const api = window.zcodeCanvas;
const $ = (id) => document.getElementById(id);
const theme = $("theme");
const fit = $("fit");
const file = $("file");
const status = $("status");

// Each slider in percent (blur is px): config ↔ slider value ↔ live label.
const KNOBS = {
  blur: { to: (v) => v, from: (c) => c ?? 0, fmt: (v) => `${v}px` },
  dim: { to: (v) => v / 100, from: (c) => Math.round((c ?? 0.35) * 100), fmt: (v) => `${v}%` },
  scale: { to: (v) => v / 100, from: (c) => Math.round((c ?? 1) * 100), fmt: (v) => `${v}%` },
  saturate: { to: (v) => v / 100, from: (c) => Math.round((c ?? 1) * 100), fmt: (v) => `${v}%` },
  brightness: { to: (v) => v / 100, from: (c) => Math.round((c ?? 1) * 100), fmt: (v) => `${v}%` },
  contrast: { to: (v) => v / 100, from: (c) => Math.round((c ?? 1) * 100), fmt: (v) => `${v}%` },
  grayscale: { to: (v) => v / 100, from: (c) => Math.round((c ?? 0) * 100), fmt: (v) => `${v}%` },
};

function say(message) {
  status.textContent = message;
}

function showKnob(key, value) {
  $(`${key}-val`).textContent = KNOBS[key].fmt(Number(value));
}

async function refresh() {
  const data = await api.get();
  theme.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "无主题";
  theme.append(none);
  for (const item of data.themes) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name === item.id ? item.id : `${item.name} (${item.id})`;
    theme.append(option);
  }
  theme.value = data.config.theme ?? "";
  const wallpaper = data.config.wallpaper ?? {};
  fit.value = wallpaper.fit ?? "cover";
  for (const key of Object.keys(KNOBS)) {
    const slider = $(key);
    slider.value = KNOBS[key].from(wallpaper[key]);
    showKnob(key, slider.value);
  }
  file.textContent = data.wallpaper.file
    ? `当前文件：${data.wallpaper.file}`
    : data.wallpaper.fromTheme
      ? "当前：主题自带壁纸"
      : "当前：未设置壁纸";
}

async function apply(value, done) {
  try {
    await api.apply(value);
    await refresh();
    say(done);
  } catch (error) {
    say(`失败: ${error.message}`);
  }
}

if (!api) {
  say("面板初始化失败");
} else {
  refresh().catch((error) => say(`读取失败: ${error.message}`));

  theme.addEventListener("change", () => apply({ theme: theme.value || null }, "已切换主题"));

  $("pick").addEventListener("click", async () => {
    say("正在选择图片…");
    try {
      const result = await api.pickWallpaper();
      if (result.canceled) {
        say("已取消选择");
        return;
      }
      await refresh();
      say("已设置壁纸");
    } catch (error) {
      say(`失败: ${error.message}`);
    }
  });

  $("clear").addEventListener("click", () => apply({ wallpaper: null }, "已清除壁纸，主题壁纸重新生效"));
  $("reset").addEventListener("click", () => apply({ theme: null, wallpaper: null }, "已恢复默认外观"));

  fit.addEventListener("change", () => apply({ fit: fit.value }, "已更新铺放方式"));
  for (const [key, knob] of Object.entries(KNOBS)) {
    const slider = $(key);
    slider.addEventListener("input", () => showKnob(key, slider.value));
    slider.addEventListener("change", () => apply({ [key]: knob.to(Number(slider.value)) }, "已更新"));
  }
  $("tune-reset").addEventListener("click", () =>
    apply({ fit: "cover", blur: 0, dim: 0.35, scale: 1, saturate: 1, brightness: 1, contrast: 1, grayscale: 0 }, "已重置壁纸调整"),
  );
}
