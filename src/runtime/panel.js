const api = window.zcodeCanvas;
const theme = document.querySelector('#theme');
const wallpaper = document.querySelector('#wallpaper');
const fit = document.querySelector('#fit');
const blur = document.querySelector('#blur');
const dim = document.querySelector('#dim');
const status = document.querySelector('#status');

function fileName(file) { return file.split(/[\\/]/).pop(); }

(async () => {
  try {
    const data = await api.get();
    for (const item of data.themes) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name === item.id ? item.id : `${item.name} (${item.id})`;
      theme.append(option);
    }
    for (const file of data.wallpapers) {
      const option = document.createElement('option');
      option.value = file;
      option.textContent = file;
      wallpaper.append(option);
    }
    theme.value = data.config.theme ?? '';
    const current = data.config.wallpaper ?? {};
    wallpaper.value = current.image ? data.wallpapers.find((file) => fileName(file) === fileName(current.image)) ?? '' : '';
    fit.value = current.fit ?? 'cover';
    blur.value = current.blur ?? 0;
    dim.value = current.dim ?? 0.35;
  } catch (error) {
    status.textContent = `读取失败: ${error.message}`;
  }
})();

document.querySelector('#save').addEventListener('click', async () => {
  status.textContent = '正在应用…';
  try {
    await api.apply({ theme: theme.value || null, wallpaper: wallpaper.value || null, fit: fit.value, blur: Number(blur.value), dim: Number(dim.value) });
    status.textContent = '已应用，主窗口会实时刷新';
  } catch (e) {
    status.textContent = `失败: ${e.message}`;
  }
});
