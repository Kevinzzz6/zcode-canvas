# ZCode Canvas

给**官方发布版** ZCode Desktop 换主题、换壁纸、开毛玻璃、改启动画面。不需要自己编译 ZCode，也不需要维护 fork。

- **主题**：一套主题就是一个文件夹，里面有 `theme.json` 和图片，可以直接分享
- **壁纸**：png / jpg / webp / avif / gif / svg，支持模糊、压暗和多种铺放方式
- **毛玻璃**：界面表面半透明，透出 Windows 原生 acrylic / mica 材质或壁纸
- **配色**：直接覆盖 ZCode 的设计 token，亮色和暗色分开配置，支持单独设强调色
- **启动画面**：可改背景、换 logo 图片、换动画
- **热更新**：修改配置或主题文件后，正在运行的 ZCode 约 1 秒内刷新，不用重启

> 支持 Windows、Linux 和 macOS。已在 ZCode 3.14.3（Electron 41）上验证。
>
> | 平台 | 安装格式 | 说明 |
> |---|---|---|
> | Windows 10/11 | NSIS 安装版 | 已验证 |
> | Fedora / RHEL / 其他 rpm 系 | `.rpm` | 已验证路径（`/opt/ZCode`，apply 需要 sudo） |
> | Debian / Ubuntu 等 deb 系、Arch 系 pacman | `.deb` / `.pacman` | 走同样的 `/opt` 布局，未逐一验证 |
> | macOS | `.dmg`（拖入 /Applications） | apply 后自动做 ad-hoc 重签名 |
>
> **AppImage 不支持**：它的 `app.asar` 封在只读 squashfs 里，无法打补丁。Linux 用户请安装 rpm / deb / pacman 包（Fedora：`sudo dnf install ./ZCode-*.x86_64.rpm`）。

## 安装

需要 Node.js 20 或更高版本。

```sh
git clone https://github.com/Kevinzzz6/zcode-canvas.git
cd zcode-canvas
npm install
npm run build
npm link            # 之后可以直接用 zcode-canvas 命令；不想 link 就用 node dist/cli.js
```

然后打补丁：

- **Windows**：`zcode-canvas apply`。ZCode 装在 Program Files 这类受保护目录时，需要用管理员身份运行终端。
- **Linux（rpm/deb/pacman）**：`sudo zcode-canvas apply`。ZCode 装在 `/opt/ZCode`（root 所有），补丁需要 root 权限；运行时和配置仍会装到**你的**用户目录（Canvas 会识别 `SUDO_USER`），不会放到 `/root` 下，文件所有权也会归还给你（无需手动 chown）。若 `sudo` 找不到命令，用 `sudo env "PATH=$PATH" zcode-canvas apply` 或 `sudo "$(which zcode-canvas)" apply`。
- **macOS**：`zcode-canvas apply`（ZCode.app 不可写时加 `sudo`）。**请先启动过一次 ZCode 再 apply**：修改 `.app` 会破坏官方代码签名，Canvas 会自动做 ad-hoc 重签名（`codesign --force --deep --sign -`）；已被系统放行的应用重签后可以正常启动，但保存的登录凭据可能失效，需要重新登录。`restore` 会把 `app.asar` 逐字节还原，但签名仍停留在 ad-hoc——想完全回到官方签名，重新安装一次 ZCode 即可。

`apply` 会把运行时装到 `~/.zcode-canvas/`，然后给 ZCode 打补丁。

- **ZCode 没在运行**：立即生效，启动 ZCode 即可看到效果。
- **ZCode 正在运行**（仅 Windows 会出现）：`app.asar` 被占用，Canvas 会先准备好补丁文件，再启动一个后台小进程等待。请从托盘**彻底退出** ZCode（关闭窗口只会缩到托盘），后台进程会自动换上补丁，之后重新启动 ZCode 即可。所以直接在 ZCode 自带的终端里执行也没问题。Linux 和 macOS 上文件可以随时替换，正在运行的 ZCode 不受影响，重启后生效。

## 使用

```sh
zcode-canvas themes                          # 列出主题
zcode-canvas use aurora                      # 切换主题，ZCode 实时刷新
zcode-canvas set wallpaper.image ~/pic.jpg   # 换壁纸
zcode-canvas set wallpaper.dim 0.4           # 壁纸压暗
zcode-canvas set glass.opacity 0.6           # 界面半透明
zcode-canvas set accent "#7c5cff"            # 强调色
zcode-canvas unset wallpaper                 # 删除设置，回到主题默认值
zcode-canvas new my-theme                    # 把当前设置存成主题（会复制用到的图片）
zcode-canvas wallpaper import <项目目录>      # 导入 project.json type=image 的静态原图
zcode-canvas wallpaper import <项目目录> --preview # 显式导入 scene/video/web 的静态预览图
zcode-canvas status                          # 查看安装状态
zcode-canvas open                            # ZCode 运行中打开外观中心，否则打开配置目录
zcode-canvas restore                         # 还原官方 app.asar
```

所有设置都存在 `~/.zcode-canvas/config.json` 里，直接编辑这个文件也可以，保存后立即生效。`accent` 会覆盖主题强调色生成的 `primary`、`brand`、`ring` 和 `primary-foreground`；用户 `colors` 中显式指定的 token 优先。完整的键列表见 `zcode-canvas help`。

### 内置主题

| id | 说明 |
|---|---|
| `glass` | 保留官方配色，透出系统原生毛玻璃（Windows acrylic / macOS vibrancy / Linux 透明窗口） |
| `mica` | 保留官方配色，改用 Windows 11 Mica 材质（仅 Windows，其他平台效果等同 `glass`） |
| `aurora` | 极光壁纸 + 深蓝配色，青色强调，适合暗色模式 |
| `sakura` | 樱粉渐变 + 粉色强调，适合亮色模式 |
| `eye-care` | 偏暖低亮的护眼配色，亮色和暗色都有；配色改编自 [zcode-eye-care](https://github.com/VoodooB0Ys/zcode-eye-care) |
| `endfield` | 终末地官网风格：谷地黄强调、等高线地形壁纸、全直角；暗色墨黑底，亮色奶油纸底；改编自 [dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield) |
| `endfield-wuling` | 同一风格的武陵青版本，同样适配暗色和亮色 |

自己写主题请看 [docs/theme-format.md](docs/theme-format.md)。主题格式目前是 format 1，之后只做向后兼容的新增；[schema/theme.schema.json](schema/theme.schema.json) 可以让编辑器补全和校验 `theme.json`，`zcode-canvas use` / `themes` 也会按同一份 schema 完整校验第三方主题。

## Wallpaper Engine 本地导入

只读取用户明确指定的本地项目目录和 `project.json`，不会联网、解包 pkg、执行 JS/exe 或修改 Wallpaper Engine 目录。`type: image` 仅导入其入口图片；`scene`、`video`、`web` 默认拒绝，只有显式加 `--preview` 才导入 `preview` 预览图。支持 png、jpg/jpeg、webp、avif、svg、gif——GIF 的动画会直接在 CSS 背景里播放，相当于轻量动态壁纸；但不会运行任何 Wallpaper Engine 内容。选中的文件会复制到 Canvas 自有的 `~/.zcode-canvas/imports/wallpaper/` 并应用；若个人配置尚未设置壁纸 `dim`，导入会设为 `0`，保留其它配置。既有配置不会自动迁移。

```sh
zcode-canvas wallpaper import "D:\\SteamLibrary\\steamapps\\workshop\\content\\431960\\项目目录"
zcode-canvas wallpaper import ./my-project --preview
```

项目目录为必要参数；不会为了导入而扫描或修改 Steam Workshop。

### 外观中心

每个 ZCode 主窗口的侧边都有一个小巧的 **外观** 入口，点击即可展开页内面板，背后的 IDE 就是实时预览。外观中心只在主窗口内显示；托盘、应用菜单、窗口内快捷键 `Ctrl/Cmd+Alt+Shift+O` 和 `zcode-canvas open` 都会打开最近使用或当前聚焦的主窗口面板。没有可用主窗口时，`zcode-canvas open` 安全地打开 Canvas 配置目录。入口默认在右侧、状态栏与常见通知区域上方；可以直接拖到左右边缘，右键隐藏或重置位置。不检测或依赖宿主的通知 DOM。

- **主题**：自动生成色卡，点击切换原生 / 内置 / 用户主题；用户的强调色、圆角、材质和壁纸等覆盖在切换主题时保留。
- **我的壁纸**：三列缩略图浏览 `~/.zcode-canvas/imports/wallpaper/` 中已导入的图片，点击直接使用。“添加图片”打开由主窗口拥有的原生文件选择器，复制图片到 Canvas 自有库后应用；“恢复主题壁纸”清除壁纸覆盖。缩略图懒加载，GIF 冻结为静帧，实际 GIF 壁纸仍然播放。
- **通用界面**：调整界面透明度、毛玻璃模糊和图片亮度；主题样式还可单独调整强调色、圆角和材质。
- **壁纸微调**：调整铺放方式、X/Y 位置（含居中）、模糊、缩放、饱和度、亮度、对比度和灰度。拖动预览由主进程只读校验并生成完整 CSS，仅替换当前窗口样式，不写配置也不广播；过期预览会忽略。松手后才原子保存并同步所有主窗口；保存失败恢复已保存的效果。新导入的图片在未设置个人 `dim` 时默认不叠加旧遮罩（`dim: 0`），旧配置不会自动迁移；检测到旧遮罩时会在图片亮度旁提示，可直接清除。
- **精确调节**：点击滑杆右侧的数值可直接输入（如 `100`、`18px`、`1.5×`），回车应用、Esc 取消，超出范围会自动限制并提示；方向键在模糊、缩放上也按 1px / 1% 步进（Shift ×10）。模糊和缩放的轨道对常用低值区间更细：一半轨道只对应四分之一的模糊范围，缩放 100% 位于轨道前四分之一处。轨道上的细刻度标出主题默认值。
- **为什么没变化**：调节被其他条件挡住时，面板会就近说明原因。界面完全不透明时，壁纸被遮住，毛玻璃模糊也不生效（该滑杆禁用）；壁纸会盖住 Windows 原生材质；图片在当前窗口某个方向没有裁切余量时，对应的位置滑杆不会改变画面（只提示，因为其他窗口尺寸可能不同）；拉伸铺满且缩放为 100% 时位置无效（禁用）。
- **覆盖重置**：单项偏离主题默认时，行尾出现 ↺，只删除这一项个人覆盖，恢复跟随主题。恢复主题默认会删除个人 `glass`、`accent` 和 `radius` 覆盖，保留壁纸选择及相关个人设置。切换主题时个人覆盖保留。

再次点击入口、按 Esc、点击外部或关闭按钮收起，保留已应用的外观。浮层不推挤编辑器，也不改变代码布局。快捷键仅在 ZCode 主窗口生效，录制快捷键时会让位；托盘优先打开最近使用的主窗口。批量导入等管理操作继续使用 CLI，不放进浮层。

外观配置仍全局共享，走现有主进程校验、原子写入及热更新，不需要重启 ZCode。入口位置/隐藏仅是 UI 偏好，不改变主题配置。

官方更新会整体替换 `app.asar`，补丁随之消失，ZCode 只是回到官方原样，不会有任何损坏。重新执行一次 `zcode-canvas apply`（只需几秒）即可恢复补丁。主题和配置都在 `~/.zcode-canvas/`，不受更新影响。

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

   首次打补丁前会独立校验官方 `app.asar` 的头部能被逐字节往返重写——校验不过就拒绝打补丁，保证 `restore` 还原出的文件与官方原文件逐字节一致不是一句空话。

   引导脚本先加载 `~/.zcode-canvas/runtime/main.cjs`，再导入 ZCode 原来的入口。运行时加载失败不会影响 ZCode 启动。
2. **运行时在 ZCode 的主进程里运行**。它给默认 session 注册一个预加载脚本，在页面首帧之前用 `webFrame.insertCSS` 注入样式，所以启动画面也能改。样式不写进 DOM，React 碰不到它，也就不需要 MutationObserver。窗口材质按平台切换：Windows 用 `setBackgroundMaterial`，macOS 用 `setVibrancy`，Linux 窗口本身就是透明的不用切换。配置文件变化时通过 IPC 推送新样式。
3. **样式只依赖 ZCode 源码里明确的结构**：
   - `--color-*` 设计 token 和 `.dark` / `.theme-zai-*` 主题 class；
   - 窗口外框 `[data-desktop-window-frame]`；
   - 启动画面的 `#loading` 和 `body.zcode-startup-ready`。

   Windows 主窗口本身就是 acrylic 材质、macOS 是原生 vibrancy、Linux 是透明窗口，只是被一层不透明（macOS 为半不透明）的外框背景盖住了，所以毛玻璃效果只需要把这些 token 调成半透明。Linux 的窗口透明依赖合成器；不支持时毛玻璃退化为纯色，壁纸不受影响（壁纸绘制在页面内部）。
4. **壁纸直接用 `file://` 地址**。主界面是没有 CSP 的 `file://` 页面，因此不需要 data URL、本地 HTTP 服务或 CDP。
5. **不开任何调试端口，没有常驻进程**。从开始菜单、任务栏、协议链接或托盘启动 ZCode 都会生效。

## 开发

改代码或提 issue 前请先读 [docs/design.md](docs/design.md)：它规定了安全底线、各部分的稳定程度、依赖 ZCode 内部实现的清单，以及哪些问题要修、哪些不修。

```sh
npm run typecheck
npm test
npm run build
```

`scripts/sandbox.mjs` 可以启动一份官方 ZCode 的副本，身份和数据目录完全隔离，配合 `scripts/cdp.mjs` 截图验证，不会碰到你正在使用的 ZCode。这两个脚本目前只在 Windows 上可用，仅用于开发，Canvas 本身不使用 CDP。

构建后可运行 `node scripts/runtime-smoke.mjs`，用隔离的 Electron 实例验证两个主窗口同步、辅助窗口排除和 IPC 拒绝越界访问，不打开调试端口。启动开发沙箱并在沙箱里准备好含 GIF 的测试壁纸库后，可运行 `node scripts/overlay-smoke.mjs` 验证真实浮层的点选、预览/提交、失败恢复、GIF 静帧、入口拖动/隐藏/唤回与焦点恢复，并保存截图。后者仅接受明确指定的沙箱目录，临时配置修改会在结束时还原。

`endfield` 两套主题的壁纸和启动字标由 `npm run build:endfield` 生成，生成结果已提交；只有想换地形（`--seed <n>`）或改排版时才需要重新运行。

## 致谢

以下社区项目在 ZCode 开源之前就做出了外观增强，是本项目的重要参考：
[zcode-beautify](https://github.com/Logocceai/zcode-beautify)、
[zcode-dream-skin](https://github.com/Alan-dong-dong/zcode-dream-skin)、
[zcode-eye-care](https://github.com/VoodooB0Ys/zcode-eye-care)、
[zcode-skin-center](https://github.com/Theater-ahyeon/zcode-skin-center)、
[zcode-mod-kit](https://github.com/Adam1290-0/zcode-mod-kit)、
[zcode-miku-theme](https://github.com/foambai/zcode-miku-theme)、
[dream-work-theme](https://github.com/xxxhh336/dream-work-theme)。

`endfield` 主题改编自 DSH 主题 [dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield)（MIT），详见 [NOTICE.md](NOTICE.md)。

本项目与 ZCode 官方无关。修改 `app.asar` 的风险由使用者自行承担。

## 许可

MIT
