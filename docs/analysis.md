# ZCode Canvas 前期分析

> 基线：ZCode 开源仓库 `zai-org/ZCode` @ `29628c9`（3.14.3，2026-09-24）；
> 本机官方安装版 `D:\ZCode`，`app.asar` 内 `@zcode/desktop` 3.14.3，Electron 41.0.3。
> 参考项目克隆在 `D:\code\zai\_refs\`。

## 1. 从源码确认的事实

### 1.1 窗口与材质

`packages/desktop/src/main/desktopWindowChrome.ts` `buildDesktopWindowVisualOptions()`：

| 平台 | 主窗口视觉选项 |
|---|---|
| Windows | `backgroundColor:"#00000000"`, `frame:false`, `backgroundMaterial:"acrylic"` |
| macOS | `backgroundColor:"#00000000"`, `titleBarStyle:"hidden"`, `vibrancy:"under-window"` |
| Linux | `backgroundColor:"#00000000"`, `transparent:true`, `frame:false` |

**Windows 主窗口本来就是 acrylic 材质**，看起来不透明，只是因为
`packages/ui/src/DesktopWindowFrame.tsx` 在 Windows/Linux 上给根容器
`[data-desktop-window-frame="true"]` 加了不透明的 `bg-background-win-alt`；macOS 用的是半透明的
`bg-background-alt`。所以“真·透明/毛玻璃”（透出桌面）在 Windows 上只需要改 CSS，
不需要改 BrowserWindow。切换 mica / acrylic / none 则需要主进程调用 `win.setBackgroundMaterial()`。

社区项目都没有发现这一点，全部是“把背景 token 设成 transparent + 自己垫一层壁纸”。

### 1.2 渲染页、CSP、资源加载

- 生产环境 `win.loadFile(out/renderer/index.html)`，origin 是 `file://`。
- 主渲染页 **没有 CSP**（index.html 无 meta，主进程无 `onHeadersReceived` 注入）。
- `GrantFileProtocolExtraPrivileges` fuse 开启。
- 结论：壁纸可以直接用 `file:///...` URL 引用，不需要 data URL、本地 HTTP 服务、CORS/PNA 头。

### 1.3 主题与 Token 结构

- `packages/ui/src/styles.css`：Tailwind v4，`@theme`（基础）→ `.dark`（308 行）→ `.theme-zai-light`（461）→ `.theme-zai-dark`（606）。
- `html, body, #root { background: transparent !important; }` 已存在。
- 主题存在 localStorage `zcode-theme`：`light | dark | zai-light | zai-dark | system`，默认 `zai-dark`。
  根节点 class 组合：`dark` + `theme-zai-dark` / `theme-zai-light` / 无（经典 light/dark）。
- 平台 class：`platform-windows-desktop` / `platform-mac-desktop` / `platform-linux-desktop`。
- 关键表面 token：`--color-background`、`-background-win-alt`、`-background-alt`、`-sidebar`、`-panel`、
  `-header`、`-card`、`-popover`、`-input`、`-menu`、`-tab(-active)`、`-surface`、`-secondary`、
  `-terminal-bg` 等；强调色 `--color-primary`、`-brand`、`-accent`；文字 `--color-foreground*`。
- 代码/Diff 查看器 `@pierre/diffs` 在 Shadow DOM 里渲染，但颜色走 `--diffs-*` 自定义属性（会继承进 Shadow DOM），
  不需要往 shadowRoot 里塞样式。

### 1.4 启动画面

- 没有独立 splash 窗口。`packages/desktop/src/renderer/index.html` 内联 `#loading` 遮罩：
  96px 黑色渐变圆角 logo 壳 + 白色 SVG + `startup-logo-pop` 动画。
- `#root` 初始 `opacity:0`，`body.zcode-startup-ready` 后淡入，`#loading` 随后移除。
- 要可靠改启动画面，样式必须在 **首帧之前** 生效。CDP 注入做不到（连上时页面已经画完）。

### 1.5 扩展点

**官方没有任何外观扩展点**：无 custom CSS、无主题导入、插件系统只提供 skills/commands/hooks/MCP。
`~/.zcode/v2/setting.json` 里也没有主题字段。所以“往官方进程里放代码”这件事本身仍然绕不开。

### 1.6 官方安装版的 Electron fuse（读取自 `D:\ZCode\ZCode.exe`）

| Fuse | 状态 | 影响 |
|---|---|---|
| RunAsNode | on | |
| EnableNodeOptionsEnvironmentVariable | on | 但 Electron 对打包应用禁用了 `NODE_OPTIONS --require` |
| EnableNodeCliInspectArguments | on | `--inspect` 可用 |
| EnableEmbeddedAsarIntegrityValidation | **off** | 修改 `app.asar` 不会被拒绝 |
| OnlyLoadAppFromAsar | off | |
| GrantFileProtocolExtraPrivileges | on | file:// 资源可加载 |

`--remote-debugging-port` 在生产环境没有被屏蔽。

### 1.7 更新

- electron-updater + 自定义 manifest provider；Windows 默认 `autoInstallOnAppQuit=false`，用户手动安装。
- NSIS 安装器会重写安装目录 → **任何对 `app.asar` 的修改在更新后都会丢失**。
- 本机 `D:\ZCode\resources` 对 Authenticated Users 有修改权限；装在 Program Files 时需要管理员权限。

## 2. 社区项目的实现方式

| 项目 | 注入 | 壁纸传递 | 透明/玻璃 | 启动画面 | 形态 |
|---|---|---|---|---|---|
| zcode-beautify | CDP（改快捷方式/注册表加端口）+ 常驻 daemon | data URL | token 半透明 + 壁纸层模糊 | 无 | CLI + ZCode 插件 + 页内悬浮面板 |
| zcode-dream-skin | CDP + daemon + 浏览器控制面板 | data URL | getComputedStyle 采样后写内联变量 | 无 | CLI + Web 面板 |
| zcode-eye-care | 重打包 asar，main 末尾追加 import 外部 loader，`insertCSS` | — | — | 无 | Python 安装器 |
| zcode-skin-center | asar 追加文件，index.html 插 `<script>` | asar 内相对路径 | token rgba + 壁纸层 | 无 | CLI + 页内面板 |
| zcode-mod-kit | `@electron/asar` 解包/重打包（2~3 分钟），index.html 插脚本 | file:// URL | token + `backdrop-filter` | 无 | Python TUI |
| zcode-miku-theme | CDP + 看门狗强杀重启 + `--remote-allow-origins=*` | data URL | 8 位色 alpha | 无 | PowerShell 脚本 |
| dream-work-theme | CDP（通用多应用管理器） | data URL / 本地 HTTP | 根容器透明 + `html::before` | 无 | 独立 Electron GUI |

共同点：都是 CSS 变量覆盖 + 底层壁纸；没人动原生材质；没人改启动画面。

## 3. 哪些旧复杂度可以删掉

| 旧实现 | 为什么当时需要 | 现在 |
|---|---|---|
| DOM 探针脚本、`getComputedStyle` 采样、DevTools 侦察 token | 不知道 token 名和结构 | **删除**。token 契约直接从 `styles.css` 得到 |
| `[class*="min-h-0"][class*="flex-1"]`、`:not(.shrink-0)` 这类类名猜测 | 没有稳定锚点 | **删除**。只用 token + 源码里明确的锚点（`data-desktop-window-frame`、主题/平台 class、`#loading`） |
| 用 UI 文字（“选择项目”）判断路由 | 不知道路由结构 | **删除**（第一阶段不需要按页面区分） |
| MutationObserver / 250ms 守卫把被 React 删掉的 `<style>` 挂回去 | 往 DOM 里塞 style | **删除**。用 Electron `insertCSS`，不进 DOM，React 碰不到 |
| data URL 壁纸、localStorage 图片配额、本地 HTTP 服务 + CORS/PNA 头 | 以为有 CSP/跨域限制 | **删除**。无 CSP 的 file:// 页面直接引用 file:// 壁纸 |
| 快捷方式/注册表改写、看门狗强杀重启、daemon 轮询 `/json/list` | CDP 只在带端口启动时可用，刷新即丢 | **删除**（不走 CDP） |
| 暴露调试端口（miku 还开了 `--remote-allow-origins=*`） | 同上 | **删除**。ZCode 能执行命令，开放调试端口等于给本机任意进程远程控制权 |
| 解包/重打包 2.7 万文件（2~3 分钟）、猜 asar 数据区偏移 | 把 asar 当黑盒 | **简化**。只改 `package.json` 一个条目 + 追加一个小引导文件，按标准格式重写头部 |
| 版本白名单靠试 | 不知道每版改了什么 | **简化**。以源码 token 为契约，可按版本 diff `styles.css` 判断兼容性 |

## 4. 哪些仍然必要

1. **必须往官方进程里放代码**：官方没有外观扩展点。
2. **启动画面必须在首帧前生效**：只能在主进程/预加载层做，CDP 不行。
3. **原生材质切换必须在主进程**：`setBackgroundMaterial` / `setVibrancy`。
4. **官方更新会覆盖 `app.asar`**：需要一条命令重新应用，并能检测“补丁已丢失”。
5. **修改 asar 时 ZCode 必须完全退出**（关窗只是进托盘）。
6. **token 会随版本变化**：需要记录验证过的版本，但这次有源码可以对照。

## 5. 推荐实现方式

**最小 asar 引导 + 外置运行时。**

```
官方 app.asar（只改两处）
 ├─ package.json               "main": "out/zcode-canvas/boot.mjs"   ← 唯一改动的原文件
 ├─ out/zcode-canvas/boot.mjs  ← 新增，约 20 行：
        try { 加载 ~/.zcode-canvas/runtime/main.cjs } catch {}  // 出错不影响 ZCode
        await import("../main/index.js")                       // 原入口照常启动
 └─ out/zcode-canvas/restore.json ← 新增：原 package.json 条目和原数据区长度

~/.zcode-canvas/（用户目录，全部逻辑和资源在这里，升级 Canvas 不用再动 asar）
 ├─ runtime/main.cjs     主进程：注册 session 预加载、切换窗口材质、监听配置热更新
 ├─ runtime/preload.cjs  预加载：首帧前 webFrame.insertCSS（覆盖启动画面）
 ├─ themes/<id>/theme.json + 资源
 └─ config.json          当前主题、壁纸、透明度等
```

为什么选它：

- 不开任何调试端口，没有 daemon，所有启动入口（开始菜单、任务栏、协议唤起、托盘重启）都生效。
- 运行时在 ZCode 自己的 main 之前加载，可以在首帧前注入 CSS，所以能改启动画面；能调用原生材质 API。
- 对官方文件的改动是可审查的两处小改动；原数据区一个字节都不动，只在末尾追加，还原能做到逐字节一致。
- 缺点：官方更新后需要重新执行一次 `apply`（几秒，不需要解包）。

放弃的方案：

- **CDP 注入**：要改所有启动入口、开调试端口、常驻进程，刷新即丢，做不了启动画面和原生材质。
- **`--inspect-brk` 启动器**：不改安装文件，但同样只对经由启动器的启动生效，且短时暴露主进程调试端口。
- **`NODE_OPTIONS=--require`**：Electron 对打包应用禁用。
- **改 `index.html` 插脚本**：能改启动画面，但拿不到主进程能力（材质、文件监听）。

## 6. 平台风险

- **Windows**：首选。安装在用户可写目录时无需管理员。
- **macOS**：修改 `.app` 内的 asar 会破坏代码签名封印；可能需要 ad-hoc 重签并触发“App 管理”权限提示。建议放到后续阶段。
