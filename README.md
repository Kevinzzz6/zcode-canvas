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

所有设置都存在 `~/.zcode-canvas/config.json` 里，直接编辑这个文件也可以，保存后立即生效。完整的键列表见 `zcode-canvas help`。

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

只读取用户明确指定的本地项目目录和 `project.json`，不会联网、解包 pkg、执行 JS/exe 或修改 Wallpaper Engine 目录。`type: image` 仅导入其入口图片；`scene`、`video`、`web` 默认拒绝，只有显式加 `--preview` 才导入 `preview` 预览图。支持 png、jpg/jpeg、webp、avif、svg、gif——GIF 的动画会直接在 CSS 背景里播放，相当于轻量动态壁纸；但不会运行任何 Wallpaper Engine 内容。选中的文件会复制到 Canvas 自有的 `~/.zcode-canvas/imports/wallpaper/`，并仅更新 `wallpaper.image`，保留其它配置。

```sh
zcode-canvas wallpaper import "D:\\SteamLibrary\\steamapps\\workshop\\content\\431960\\项目目录"
zcode-canvas wallpaper import ./my-project --preview
```

项目目录为必要参数；不会为了导入而扫描或修改 Steam Workshop。

### 外观中心

运行中的 ZCode 可以通过菜单里的 **ZCode Canvas → 打开外观中心**（Windows 无边框窗口看不到菜单栏，入口在**托盘右键菜单**里），或 ZCode 窗口内按 `Ctrl/Cmd+Alt+Shift+O` 打开外观中心——这个快捷键只在 ZCode 窗口获得焦点时生效，不是系统级全局热键；ZCode 录制快捷键时会自动让位，可以把这个组合绑定给 ZCode 自己的命令。也可以运行 `zcode-canvas open` 请求当前 ZCode 打开它。ZCode 重建菜单（切换语言、缩放等）时入口会自动补回。面板只有两组设置：

- **主题**：下拉切换（无主题 / 内置 / 用户主题），选中即生效，正在使用的主窗口就是预览；
- **当前壁纸**：点“选择图片”从原生文件对话框选一张（png / jpg / jpeg / webp / avif / svg / gif），图片会复制进 Canvas 自己的目录再设为壁纸（文件名带内容哈希，同名不同图不会互相覆盖）；“清除壁纸”取消单独设置，让主题自带的壁纸重新生效。铺放、模糊、压暗随改随生效；“恢复默认外观”只取消主题和壁纸覆盖，不删除任何文件。

所有修改都走现有的热更新机制实时刷新主窗口，不需要重启 ZCode。

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
