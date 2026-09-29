# 设计约束

这份文档记录 Canvas 往后一直生效的规则：什么必须保证、什么只是尽力而为、依赖了 ZCode 的哪些内部实现、哪些问题要修、哪些不修。调研过程和实测结论见 [analysis.md](analysis.md)，那份是历史记录；两者冲突时以本文为准。

写代码、做评审、提 issue 之前先读一遍。

## 1. 安全底线

> Canvas 的任何功能出问题时，最坏结果只能是“这个功能没生效”。它绝不能让 ZCode 启动失败或功能受损，也绝不能阻碍官方更新。

这是最高优先级，代码评审和测试都以它为准。具体来说：

- 运行时的每个入口都要包在 `try/catch` 里，出错只写 `runtime.log`，不抛给 ZCode。
- 运行时加载失败时，引导脚本照常启动 ZCode；`ZCODE_CANVAS_DISABLE=1` 总能完全绕开 Canvas。
- 更新期间，任何 Canvas 进程都不能从 ZCode 安装目录里运行，也不能占用安装目录里的文件（官方安装器会结束这类进程并整体替换目录内容）。
- 拿不准的时候宁可不做：`app.asar` 和预期不一致就拒绝改写，读不懂的新版 IPC 消息就忽略。

## 2. 各部分的稳定程度

| 部分 | 等级 | 承诺 |
|---|---|---|
| asar 补丁与还原、CSS 白名单、主题格式、配置读写 | 稳定 | 还原与官方文件逐字节一致；theme.json format 1 只做向后兼容的新增；CSS 值只接受白名单语法 |
| 菜单、托盘、快捷键、外观中心入口 | 尽力而为 | ZCode 改版后允许暂时失效，但不能影响 ZCode 本身 |

改动稳定部分时，必须保持上表里的承诺，并补测试锁定。尽力而为部分的改动，只要求不越过安全底线。

## 3. 依赖 ZCode 内部实现的地方

这些都不是官方接口，ZCode 任何一次发版都可能改掉。ZCode 发新版时按这张表逐条核对；以后加契约测试时，检查范围就是这张表。基线版本为 ZCode 3.14.3（`zai-org/ZCode` @ `29628c9`）。

| 依赖 | ZCode 源码位置 | Canvas 使用位置 | 失效时的表现 |
|---|---|---|---|
| `--color-*` 设计 token，`.dark` / `.theme-zai-*` 主题 class | `packages/ui/src/styles.css` | `src/shared/css.ts` | 配色或透明度部分失效 |
| 窗口外框 `[data-desktop-window-frame]` | `packages/ui/src/DesktopWindowFrame.tsx` | `src/shared/css.ts` | 毛玻璃失效 |
| 启动画面 `#loading`、`.startup-logo-shell`、`body.zcode-startup-ready` | `packages/desktop/src/renderer/index.html` | `src/shared/css.ts` | 启动画面定制失效 |
| 主窗口页面路径 `out/renderer/index.html`，其他窗口带 `windowKind` 参数 | `packages/desktop/src/main` 中创建窗口的代码 | `src/runtime/preload.ts`、`src/runtime/main.ts` 的 `senderIsMainWindow` | 样式不注入，或注入到错误的窗口 |
| 主渲染页允许 preload 向文档根节点追加自有 Shadow DOM；入口默认位于右侧、底部上方约 220px 的几何假设 | 主渲染页与窗口布局（不查询状态栏、编辑器或通知容器） | `src/runtime/overlay.ts` | 浮层可能无法显示，或入口与宿主内容重叠；可拖动、隐藏、重置，快捷键/托盘仍可唤起 |
| 应用菜单整体重建时调用 `Menu.setApplicationMenu` | `desktopApplicationMenu.ts` 的 `rebuildApplicationMenu` | `src/runtime/main.ts` 的 `wrapApplicationMenu` | 菜单入口消失 |
| 托盘菜单整体重建时调用 `Tray.setContextMenu` | `desktopTray.ts` 的 `rebuildContextMenu` | `src/runtime/main.ts` 的 `wrapTrayMenu` | Windows 托盘入口消失 |
| 快捷键录制状态的 IPC 通道 `zcode:set-shortcut-recording-active` | `packages/shared/src/channels.ts` 的 `SetShortcutRecordingActive` | `src/shared/protocol.ts`、`src/runtime/main.ts` 的 `observeShortcutRecording` | 录制快捷键期间 Canvas 快捷键不再让位 |
| Electron fuse：asar 完整性校验关闭，RunAsNode 开启 | `ZCode.exe` 的打包配置 | 整个补丁方案 | 完整性校验一旦开启，补丁方案整体失效（见第 5 节） |

新增任何对 ZCode 内部实现的依赖，都要先在这张表里加一行。

### 外观浮层的边界

- 只在现有 URL / `windowKind` 判定通过的顶层主渲染页挂载。样式与控件封装在自有 Shadow DOM 中，不观察宿主通知、编辑器或状态栏的 DOM，不修改官方 renderer 代码。
- 页内只放主题色卡、用户已导入的壁纸库和微调。添加单张图片走原生选择器；批量导入/管理继续留给 CLI 等独立工具。保留原独立外观窗口作为辅助入口。
- 壁纸缩略图使用 `loading="lazy"`；GIF 加载后用 canvas 捕获静帧并释放动画图片，不给 88 张图片增加虚拟化。实际壁纸 GIF 继续播放。
- 拖动滑杆仅在当前窗口乐观预览，松手通过主进程既有白名单校验与原子写入提交，失败清除预览、恢复已保存状态。配置全局共享，watcher 同步所有主窗口。
- 选择库内壁纸只接受受校验的平面文件 ID，主进程解析到 Canvas 自有库；不接受渲染层指定的任意路径。既有配置写入模型保持不变。
- 入口位置与隐藏状态使用带命名空间的本地 UI 偏好，不混入外观配置；入口可直接拖动，菜单只提供隐藏/显示与重置位置。关闭浮层不撤销已提交外观。

## 4. 修复门槛

- **违反安全底线的问题：** 立即修，并补一个能复现它的测试。
- **稳定部分违反承诺的问题：** 立即修。
- **尽力而为部分，在少见情况下没生效：** 记成 issue，等真实用户反馈再决定，不预先修补。
- **时序类问题**（安装器、更新器、进程退出顺序之类）：先在真实环境里复现（见第 7 节），再动代码。不根据推演出来的时序组合去修补。

评审意见也按这个门槛分级。尽力而为的部分在少见情况下没生效本身不是 bug；只有它影响了 ZCode 或官方更新，才是。

## 5. 退路

- **ZCode 开启 asar 完整性校验：** 补丁方案失效。Canvas 应该检测到这种情况，拒绝打补丁并明确提示用户，不去尝试绕过。
- **长期方向：** 向上游 `zai-org/ZCode` 提议官方的用户 CSS 扩展点，以 theme.json format 1 作为参考实现。一旦官方支持，就不再需要改 `app.asar`，第 3 节的大部分依赖也都可以删除。

## 6. 不做的事

- 不开调试端口，不走 CDP。
- 不留常驻进程；只允许一次性的后台助手，任务完成或超时就退出。
- 不修改官方 renderer 的代码，不向官方命令面板注册命令。
- 不执行、不解包、不修改 Wallpaper Engine 内容，只导入静态图片（GIF 由浏览器自己播放）。
- 官方更新后不自动重新打补丁，由用户重新执行 `zcode-canvas apply`：自动重打要和官方安装器竞争时序，还需要隐藏的后台辅助进程。
- 不联网。

有人提这类需求时，引用本节说明原因。

## 7. 验收方式

- **稳定部分：** 单元测试（`npm test`），加上在 `scripts/sandbox.mjs` 隔离沙箱里手动验证。
- 任何时候都不要在开发者自己正在使用的 ZCode 上做这些验证。
