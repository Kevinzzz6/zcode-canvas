const api = window.zcodeCanvas;
const $ = (id) => document.getElementById(id);
const theme = $("theme");
const fit = $("fit");
const blur = $("blur");
const dim = $("dim");
const file = $("file");
const status = $("status");

function say(message) {
  status.textContent = message;
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
  blur.value = wallpaper.blur ?? 0;
  dim.value = wallpaper.dim ?? 0.35;
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
  blur.addEventListener("change", () => apply({ blur: Number(blur.value) }, "已更新模糊"));
  dim.addEventListener("change", () => apply({ dim: Number(dim.value) }, "已更新压暗"));
}
