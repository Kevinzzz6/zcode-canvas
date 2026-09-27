# ZCode Canvas

给**官方发布版** ZCode Desktop 换主题、换壁纸、开毛玻璃、改启动画面。不需要自己编译 ZCode，也不需要维护 fork。

- **主题**：一套主题就是一个文件夹，里面有 `theme.json` 和图片，可以直接分享
- **壁纸**：png / jpg / webp / avif / gif / svg，支持模糊、压暗和多种铺放方式
- **毛玻璃**：界面表面半透明，透出 Windows 原生 acrylic / mica 材质或壁纸
- **配色**：直接覆盖 ZCode 的设计 token，亮色和暗色分开配置，支持单独设强调色
- **启动画面**：可改背景、换 logo 图片、换动画
- **热更新**：修改配置或主题文件后，正在运行的 ZCode 约 1 秒内刷新，不用重启

> 当前只支持 Windows。已在 ZCode 3.14.3（Electron 41）上验证。

## 安装

需要 Node.js 20 或更高版本。

```powershell
git clone https://github.com/Kevinzzz6/zcode-canvas.git
cd zcode-canvas
npm install
npm run build
npm link            # 之后可以直接用 zcode-canvas 命令；不想 link 就用 node dist/cli.js
zcode-canvas apply
```

`apply` 会把运行时装到 `~/.zcode-canvas/`，然后给 ZCode 打补丁。

- **ZCode 没在运行**：立即生效，启动 ZCode 即可看到效果。
- **ZCode 正在运行**：`app.asar` 被占用，Canvas 会先准备好补丁文件，再启动一个后台小进程等待。请从托盘**彻底退出** ZCode（关闭窗口只会缩到托盘），后台进程会自动换上补丁，之后重新启动 ZCode 即可。所以直接在 ZCode 自带的终端里执行也没问题。

如果 ZCode 装在 Program Files 这类受保护目录，需要用管理员身份运行终端。

## 使用

```powershell
zcode-canvas themes                          # 列出主题
zcode-canvas use aurora                      # 切换主题，ZCode 实时刷新
zcode-canvas set wallpaper.image D:\pic.jpg  # 换壁纸
zcode-canvas set wallpaper.dim 0.4           # 壁纸压暗
zcode-canvas set glass.opacity 0.6           # 界面半透明
zcode-canvas set accent "#7c5cff"            # 强调色
zcode-canvas unset wallpaper                 # 删除设置，回到主题默认值
zcode-canvas new my-theme                    # 把当前设置存成主题（会复制用到的图片）
zcode-canvas status                          # 查看安装状态
zcode-canvas restore                         # 还原官方 app.asar
```

所有设置都存在 `~/.zcode-canvas/config.json` 里，直接编辑这个文件也可以，保存后立即生效。完整的键列表见 `zcode-canvas help`。

### 内置主题

| id | 说明 |
|---|---|
| `glass` | 保留官方配色，透出 Windows 原生 acrylic 毛玻璃 |
| `mica` | 保留官方配色，改用 Windows 11 Mica 材质 |
| `aurora` | 极光壁纸 + 深蓝配色，青色强调，适合暗色模式 |
| `sakura` | 樱粉渐变 + 粉色强调，适合亮色模式 |
| `eye-care` | 偏暖低亮的护眼配色，亮色和暗色都有；配色改编自 [zcode-eye-care](https://github.com/VoodooB0Ys/zcode-eye-care) |

自己写主题请看 [docs/theme-format.md](docs/theme-format.md)。

## ZCode 更新之后

官方更新会整体替换 `app.asar`，补丁随之消失，ZCode 会恢复原样，不会出错。重新执行一次 `zcode-canvas apply` 即可，只需几秒。主题和配置都在 `~/.zcode-canvas/`，不受更新影响。

## 卸载

```powershell
zcode-canvas restore           # 还原 app.asar，和官方文件逐字节一致
zcode-canvas restore --purge   # 同时删除 ~/.zcode-canvas
```

临时禁用有两种方式：在 `config.json` 里设 `"enabled": false`；或者用环境变量 `ZCODE_CANVAS_DISABLE=1` 启动 ZCode，这时补丁不会加载任何东西。

## 工作原理

ZCode 开源后，很多事情可以直接从源码里确认，不必再靠猜。分析过程见 [docs/analysis.md](docs/analysis.md)，下面是最终的实现方式。

1. **补丁只改两处，并且可以完全还原**。补丁不动 `app.asar` 里任何原有字节，只追加三个文件：
   - 改过 `main` 字段的 `package.json`；
   - 约 20 行的引导脚本 `out/zcode-canvas/boot.mjs`；
   - 还原所需的记录 `out/zcode-canvas/restore.json`。

   引导脚本先加载 `~/.zcode-canvas/runtime/main.cjs`，再导入 ZCode 原来的入口。运行时加载失败不会影响 ZCode 启动。
2. **运行时在 ZCode 的主进程里运行**。它给默认 session 注册一个预加载脚本，在页面首帧之前用 `webFrame.insertCSS` 注入样式，所以启动画面也能改。样式不写进 DOM，React 碰不到它，也就不需要 MutationObserver。窗口材质通过 `setBackgroundMaterial` 切换。配置文件变化时通过 IPC 推送新样式。
3. **样式只依赖 ZCode 源码里明确的结构**：
   - `--color-*` 设计 token 和 `.dark` / `.theme-zai-*` 主题 class；
   - 窗口外框 `[data-desktop-window-frame]`；
   - 启动画面的 `#loading` 和 `body.zcode-startup-ready`。

   Windows 主窗口本身就是 acrylic 材质，只是被一层不透明的外框背景盖住了，所以毛玻璃效果只需要把这些 token 调成半透明。
4. **壁纸直接用 `file://` 地址**。主界面是没有 CSP 的 `file://` 页面，因此不需要 data URL、本地 HTTP 服务或 CDP。
5. **不开任何调试端口，没有常驻进程**。从开始菜单、任务栏、协议链接或托盘启动 ZCode 都会生效。

## 开发

```powershell
npm run typecheck
npm test
npm run build
```

`scripts/sandbox.mjs` 可以启动一份官方 ZCode 的副本，身份和数据目录完全隔离，配合 `scripts/cdp.mjs` 截图验证，不会碰到你正在使用的 ZCode。这两个脚本只用于开发，Canvas 本身不使用 CDP。

## 致谢

以下社区项目在 ZCode 开源之前就做出了外观增强，是本项目的重要参考：
[zcode-beautify](https://github.com/Logocceai/zcode-beautify)、
[zcode-dream-skin](https://github.com/Alan-dong-dong/zcode-dream-skin)、
[zcode-eye-care](https://github.com/VoodooB0Ys/zcode-eye-care)、
[zcode-skin-center](https://github.com/Theater-ahyeon/zcode-skin-center)、
[zcode-mod-kit](https://github.com/Adam1290-0/zcode-mod-kit)、
[zcode-miku-theme](https://github.com/foambai/zcode-miku-theme)、
[dream-work-theme](https://github.com/xxxhh336/dream-work-theme)。

本项目与 ZCode 官方无关。修改 `app.asar` 的风险由使用者自行承担。

## 许可

MIT
