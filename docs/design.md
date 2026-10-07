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
| asar 补丁与还原、CSS 白名单、主题格式、配置读写、保存为主题 | 稳定 | 还原与官方文件逐字节一致；theme.json format 1 只做向后兼容的新增；CSS 值只接受白名单语法；保存出的主题自包含，且与保存前外观一致 |
| 菜单、托盘、快捷键、外观中心入口 | 尽力而为 | ZCode 改版后允许暂时失效，但不能影响 ZCode 本身 |
| 桌宠的状态感知 | 尽力而为 | 读不懂日志时只会待机，不报错、不影响 ZCode；默认关闭 |

改动稳定部分时，必须保持上表里的承诺，并补测试锁定。尽力而为部分的改动，只要求不越过安全底线。

## 3. 依赖 ZCode 内部实现的地方

这些都不是官方接口，ZCode 任何一次发版都可能改掉。ZCode 发新版时按这张表逐条核对；以后加契约测试时，检查范围就是这张表。基线版本为 ZCode 3.14.3（`zai-org/ZCode` @ `29628c9`）。

| 依赖 | ZCode 源码位置 | Canvas 使用位置 | 失效时的表现 |
|---|---|---|---|
| `--color-*` 设计 token，`.dark` / `.theme-zai-*` 主题 class | `packages/ui/src/styles.css` | `src/shared/css.ts` | 配色或透明度部分失效 |
| 分区玻璃的区域划分：侧栏没有自己的背景，透出的是窗口外框；主区域是外框上的 `bg-background`；输入框聚焦时换成 `input-focused` | `WorkspaceShellLayout.tsx`、`prompt-editor/ChatPromptEditor.tsx` | `src/shared/css.ts` 的 `SURFACES`、`src/shared/glass.ts` | 某个区域的透明度调了没反应，或跟着别的区域变 |
| Tailwind 背景工具类 `.bg-background`、`.bg-panel`、`.bg-card`、`.bg-input`（毛玻璃模糊挂在它们上面） | ZCode 组件的 className | `src/shared/glass.ts` 的 `BLURRED_SURFACES`，供 `src/shared/css.ts` 的模糊和 `regionHighlightCss` 的区域高亮共用 | 对应区域的模糊失效，透明度不受影响；调这个区域时高亮不显示 |
| 窗口外框 `[data-desktop-window-frame]` | `packages/ui/src/DesktopWindowFrame.tsx` | `src/shared/css.ts`、`src/shared/glass.ts` 的 `regionHighlightCss` | 毛玻璃失效；调侧栏时高亮不显示 |
| 启动画面 `#loading`、`.startup-logo-shell`、`body.zcode-startup-ready` | `packages/desktop/src/renderer/index.html` | `src/shared/css.ts` | 启动画面定制失效 |
| 启动画面的退场时机：React 首次渲染完成、且收到 `.startup-logo-shell` 的 `animationend` 后才移除；这段脚本构建后并入主程序包，包开始执行后才开始监听，等不到就 1 秒兜底；减少动画模式下不等动画，由官方样式让 logo 静止 | `packages/desktop/src/renderer/index.html` 的内联脚本与样式 | `src/shared/css.ts` 的启动动画 | 启动画面多停留最多 1 秒，或动画没播完就被撤下 |
| 主窗口页面路径 `out/renderer/index.html`，其他窗口带 `windowKind` 参数 | `packages/desktop/src/main` 中创建窗口的代码 | `src/runtime/preload.ts`、`src/runtime/main.ts` 的 `senderIsMainWindow` | 样式不注入，或注入到错误的窗口 |
| 主渲染页允许 preload 向文档根节点追加自有 Shadow DOM；入口默认位于右侧、底部上方约 220px 的几何假设 | 主渲染页与窗口布局（不查询状态栏、编辑器或通知容器） | `src/runtime/overlay.ts` | 浮层可能无法显示，或入口与宿主内容重叠；可拖动、隐藏、重置，快捷键/托盘仍可唤起 |
| 应用菜单整体重建时调用 `Menu.setApplicationMenu` | `desktopApplicationMenu.ts` 的 `rebuildApplicationMenu` | `src/runtime/main.ts` 的 `wrapApplicationMenu` | 菜单入口消失 |
| 托盘菜单整体重建时调用 `Tray.setContextMenu` | `desktopTray.ts` 的 `rebuildContextMenu` | `src/runtime/main.ts` 的 `wrapTrayMenu` | Windows 托盘入口消失 |
| 快捷键录制状态的 IPC 通道 `zcode:set-shortcut-recording-active` | `packages/shared/src/channels.ts` 的 `SetShortcutRecordingActive` | `src/shared/protocol.ts`、`src/runtime/main.ts` 的 `observeZCodeIpc` | 录制快捷键期间 Canvas 快捷键不再让位 |
| 卡片通知的 IPC 通道 `zcode:show-task-notification`：渲染层弹出提问或审批卡片时发送（ZCode 设置里的“通知”关闭时不发；只发当前打开的会话；切换到会话时已存在的卡片不发），载荷 `{ taskId: 会话 id, status: "permission_request" \| "elicitation_request", requestId: 卡片 id }` | `packages/shared/src/channels.ts` 的 `ShowTaskNotification`、`validation.ts` 的 `taskNotificationPayloadSchema`、`ui/src/hooks/useTaskNotifications.ts` | `src/runtime/main.ts` 的 `observeZCodeIpc`、`src/shared/pet-state.ts` 的 `parsePromptNotification` | 桌宠不再显示“等你回应” |
| Electron fuse：asar 完整性校验关闭，RunAsNode 开启 | `ZCode.exe` 的打包配置 | 整个补丁方案 | 完整性校验一旦开启，补丁方案整体失效（见第 5 节） |
| 事件日志的位置和文件名：`ZCODE_LOG_DIR`，否则 `~/.zcode/cli/log/zcode-<本地日期>.jsonl`，每行一个 JSON，只追加 | `apps/zcode-cli/packages/adapters/src/logging/index.ts`、`retention.ts` 的 `formatLocalLogDate` | `src/runtime/pet-log.ts` | 桌宠一直待机 |
| ZCode 用 `BrowserWindow` 列表挑窗口（`isLastWindow`、OAuth 深链与更新弹窗里 `getAllWindows()[0]` 的兜底、`browser-window-created`），并靠 `window-all-closed` 在 macOS/Linux 上退出；任何还开着的 `BaseWindow` 都会让 `window-all-closed` 不触发 | `packages/desktop/src/main/index.ts`、`desktopOAuthDeepLink.ts`、`autoUpdater.ts`、`forceUpdatePrompt.ts` | `src/runtime/pet-desktop.ts`（桌面桌宠用 `BaseWindow`，这些逻辑都看不到它）、`src/runtime/main.ts` 的 `track`/`syncDesktopPet`（主窗口页面清零时同步销毁桌宠） | ZCode 改成按 `BaseWindow` 挑窗口时，可能选中桌宠；销毁时机失效时，ZCode 关完窗口不退出（只能在任务管理器结束），这是桌面模式最需要回归的一条 |
| ZCode 的 ARMS 采集脚本经全局 `web-contents-created` 注入所有页面（含 Canvas 自建的桌宠页面），回传依赖默认会话里的 `arms-rum-preload.cjs` | ZCode 主进程的遥测初始化 | `src/runtime/pet-desktop.ts` 的独立会话分区 `zcode-canvas-pet` | 桌宠页面里仍会出现 `ArmsRumBrowser`、`RumSDK`，但独立分区里没有回传通道，控制台打出 `ArmsEventBridge is not available, events dropped`，数据被丢弃；若 ZCode 改成别的回传方式，桌宠页面可能被当成 ZCode 页面上报 |
| 日志事件及字段：`turn.started` / `turn.completed` / `turn.failed`（手动停止时 `status` 为 `cancelled`），`model.request.started`，`tool.call.started` / `completed` / `failed` 的 `toolCallId`，`tool.permission.resolved` 的 `context.requestId`（与卡片 id 相同，回答、批准、拒绝都会写），`context.querySource`（`main_turn` / `subagent`），子代理会话 id `sess_subagent_<agentId>` 及父会话的 `subagent.*` 事件 | ZCode core runtime、`core/tool/executor/call-runner.ts`、`permission-flow.ts`、subagent 模块的日志调用 | `src/shared/pet-state.ts` 的 `parseLogLine` | 对应的状态不再出现，或桌宠停在某个状态直到超时兜底（回合 10 分钟，卡片 4 小时） |

新增任何对 ZCode 内部实现的依赖，都要先在这张表里加一行。

### 外观浮层的边界

- 只在现有 URL / `windowKind` 判定通过的顶层主渲染页挂载。样式与控件封装在自有 Shadow DOM 中，不观察宿主通知、编辑器或状态栏的 DOM，不修改官方 renderer 代码。
- 外观中心只在主窗口页内显示，不创建独立窗口。入口、托盘、应用菜单、快捷键和 `zcode-canvas open` 都打开页内面板；没有可用主窗口时，`open` 安全地打开 Canvas 配置目录。
- 页面提供主题色卡、已导入壁纸库，以及通用界面和壁纸微调。添加单张图片走由主窗口拥有的原生选择器；批量导入/管理继续留给 CLI 等独立工具。
- 壁纸缩略图使用 `loading="lazy"`；GIF 加载后用 canvas 捕获静帧并释放动画图片，不给 88 张图片增加虚拟化。实际壁纸 GIF 继续播放。
- 拖动滑杆时，主进程只读校验输入并生成完整 CSS；当前窗口替换预览样式，不写配置、不广播，过期响应忽略。松手后才通过既有白名单校验和原子写入提交，失败清除预览并恢复已保存状态；watcher 再同步所有主窗口。
- 选择库内壁纸只接受受校验的平面文件 ID，主进程解析到 Canvas 自有库；不接受渲染层指定的任意路径。既有配置写入模型保持不变。
- 通用界面可调透明度、毛玻璃模糊和图片亮度；分区玻璃可分别调侧栏、主区域、卡片、输入框的透明度，以及后三者的模糊；壁纸可调铺放、X/Y 位置（含居中）、模糊、压暗、缩放、饱和度、亮度、对比度和灰度。主题还可覆盖强调色、圆角、材质和智能配色。
- 控件被其他条件挡住时就近说明原因，不静默失效：只有在任何窗口下都确定无效时才禁用（不透明时的毛玻璃模糊、拉伸且未缩放时的位置、没有壁纸时的图片调节）；依赖窗口尺寸的判断（某方向没有裁切余量）只提示不禁用。图片尺寸由渲染层按主进程给出的 file URL 自行测量，不新增 IPC。
- 数值可直接输入，渲染层按显示单位解析并限制在范围内，主进程仍按白名单范围二次校验。单项恢复通过 `unset` 删除该项个人覆盖，让主题值重新生效，不写入默认值；位置只恢复被重置的轴。
- 用户覆盖跨主题切换保留；恢复主题默认删除个人 `glass`（含分区）、`accent`、`radius`、`palette` 覆盖并保留壁纸选择。`config.accent` 覆盖主题强调色生成的 `primary`、`brand`、`ring`、`primary-foreground`，但用户 `config.colors` 中显式 token 优先。在外观中心应用智能配色会删除个人 `accent`，之后再选强调色仍会覆盖配色的主色。
- 新导入壁纸在个人配置尚无 `dim` 时设为 `0`，CLI 导入行为相同；既有配置不自动迁移。旧版非零遮罩会在常用图片亮度控制旁提示，可清除。外观中心和 `wallpaper import` 都经 `src/shared/wallpaper-store.ts` 写入壁纸库：同一套格式白名单、带内容摘要的平面文件名、拒绝写穿库内指向库外的链接，以及上述 `dim` 规则。
- 入口位置与隐藏状态使用带命名空间的本地 UI 偏好，不混入外观配置；入口可直接拖动，菜单只提供隐藏/显示与重置位置。关闭浮层不撤销已提交外观。
- 简单 / 高级模式也是本地 UI 偏好。简单模式只隐藏「主题细节」「分区玻璃」「壁纸细节」三组控件，不改变任何已保存的外观；默认是简单模式。
- 智能配色的取色在渲染层完成：把主进程给出的当前壁纸 file URL 画进一张最长边 96px 的自有 canvas，读出像素后算出种子色和平均色，随即释放图片。跨进程只传 `#rrggbb` 种子色、风格名和平均色，主进程按白名单校验后才写入 `config.palette`；整套 token 由主进程从种子重新生成，渲染层生成的色卡只用于预览缩略图。读不到像素（例如图片解码失败）时就近提示，并保留自选颜色这条路。
- 悬停配色风格时走既有的只读预览，移开即恢复；点击才提交。
- 有个人外观覆盖时，页脚上方出现保存条：「另存为」新建用户主题，「保存」写回当前用户主题（内置主题和「原生」只能另存为，`apply` 会覆盖内置主题），「丢弃」要点两次，删除全部个人外观覆盖（含壁纸选择）。保存后切到该主题并清空个人覆盖，修改从此归主题所有。渲染层只传主题名称，主进程生成 id、只写 Canvas 自有的 `themes/` 目录。保存逻辑在 `src/shared/save-theme.ts`，与 `zcode-canvas new` 共用；它与 `resolveLook` 共用同一套逐层合并（`mergeLayers`），保存前后生成的 CSS 语义相同，由测试对所有内置主题锁定。
- 分区玻璃没单独设置的区域跟随整体「界面透明」「界面模糊」，拖动整体滑杆时这些区域的滑杆同步移动。区域的透明看不出效果时就近说明原因：侧栏（即窗口外框）不透明时其他区域只能透出侧栏颜色；主区域不会比它下面的侧栏更通透。
- 使用分区玻璃的控件时（按住或键盘聚焦滑杆、指针停在该行上），给这个区域在 ZCode 里对应的界面描一圈强调色内描边：侧栏描窗口外框，其余区域描挂毛玻璃的那些背景类。松手约 1 秒后、移开或失焦、关闭面板时撤掉；整体控件不高亮。只靠 CSS：描边规则是常量，由 preload 用自己的一份 `insertCSS` 插入和移除，与预览和已提交的样式互不干扰；不查询宿主 DOM，不新增 IPC，不写配置、不广播。

### 桌宠的边界

- 默认关闭，只有 `config.pet.enabled` 为 true 且 Canvas 总开关打开时才出现。它不是外观的一部分：不写进主题，“丢弃”外观覆盖时保留，`unsaved` 也不计它。
- 住在两处之一：ZCode 主窗口页面里（默认，**每个主窗口一只**），或者桌面模式（`config.pet.desktop`，Windows 和 macOS 上生效）下 Canvas 自建的独立窗口里（**全局一只**，窗口里的那只隐藏）。两处共用显示层 `src/runtime/pet-display.ts`（素材、气泡、台词、音效、按压、表情、透明像素判定），只有摆放不同：窗口内是 `pet.ts`，桌面是 `pet-desktop-page.ts` 加主进程的 `pet-desktop.ts`。
- 窗口内：和外观浮层一样只挂在主渲染页，DOM 封装在自有的 closed Shadow DOM 里，不查询、不观察宿主 DOM。唯一的全局监听是窗口上的被动 `pointermove`，用来判断指针是否在图片不透明的像素上，从而让透明部分的点击穿透给 ZCode。按下时阻止默认行为，不会抢走输入框焦点。
- 桌面模式的窗口：
  - `BaseWindow` 加 `WebContentsView`，不是 `BrowserWindow`，ZCode 按 `BrowserWindow` 挑窗口的逻辑都看不到它（第 3 节）。透明、无边框、不进任务栏、不可聚焦（点她不会把系统焦点交给一个 ZCode 不认识的窗口），置顶用 `"screen-saver"` 级别（其他级别实测不真正置顶）。先显示再加载页面：页面在隐藏的 `BaseWindow` 里开始绘制时永远不上屏（实测）。macOS 上窗口类型是 `"panel"`（不激活的面板，出现在每个桌面空间、浮在全屏 app 上面）；不用 `setVisibleOnAllWorkspaces({ visibleOnFullScreen })`，它每次调用都会把整个 app 切成 UI 元素再切回来，ZCode 自己的窗口和 Dock 图标会短暂消失。
  - 生命周期只看 `main.ts` 的 `renderers`（通过 `CHANNEL_GET` 握手和 `senderIsMainWindow` 校验的主窗口页面）：数量归零时在 `destroyed` 回调里同步销毁桌宠，否则 `window-all-closed` 不会触发；数量大于零且桌面模式开着时确保桌宠存在。不用 `browser-window-created` 判断主窗口。握手失效时 `renderers` 为空，桌宠不出现。桌宠窗口的 `close` 永远不阻止；窗口 `closed` 时显式关闭 `WebContentsView` 的 webContents（它不随窗口释放）。显示器、缩放变化时销毁重建。
  - 页面在独立的非持久化会话分区 `zcode-canvas-pet` 里，`contextIsolation`、`sandbox`、无 Node；专用 preload 只暴露桌宠用的通道，主进程按 webContents 身份（不按 URL）认它。它收得到 `CHANNEL_PET` 推送、可以请求 `CHANNEL_PET_GET`，但不在 `renderers` 里：不收 CSS，也不影响生命周期判断。拒绝打开新窗口、拒绝导航。
  - 点击穿透分三态：离得远时完全穿透（不装钩子）；进入狐娘外扩 96px、离开 128px 的范围内时穿透并转发鼠标移动（系统级低层鼠标钩子，一直开着会让别的窗口光标闪烁，所以只在附近开）；页面判定光标在不透明像素或打开的气泡上时可交互。判定只在光标还停在判定时的位置时有效；光标停下而没有收到移动时，主进程 250ms 一次的轮询会请页面判定当前点。拖动期间锁定为可交互。每 5 秒、拖动结束、休眠恢复后重新设置一次原生状态。
  - `setContentProtection(true)`：ZCode 的电脑操作会截屏再按坐标点击，桌宠不能出现在截图里挡住目标、截走点击。代价是用户也截不到她。
  - 拖动用固定尺寸的 `setBounds` 移动窗口（`setPosition` 在小数缩放下每次让窗口长大约 1px）。位置是 UI 偏好，存 Canvas 目录下的 `pet-position.json`（不进 `config.json`，热重载不监听它），记离最近工作区边缘的距离和所在工作区，恢复时限制在工作区内；吸附贴屏幕工作区边缘，靠左时转身。
  - Linux 上开关不可用并说明原因：Wayland 下应用不能自己定位窗口，也不支持“透明处穿透、不透明处可点”。只为真机验证，用环境变量 `ZCODE_CANVAS_PET_DESKTOP=force` 启动 ZCode 时也启用（面板注明“尚未验证”，`runtime.log` 记一行），不写进配置，Canvas 自己从不设置它。macOS 的验证步骤见 [mac-test-plan.md](mac-test-plan.md) 的 H 节。
- 状态来自两处，都是只读的（第 3 节）。一是 ZCode 的事件日志：主进程里的定时器每 500ms 读一次追加的内容，桌宠关闭时停止；启动时从当天日志的末尾开始，不回放历史；一次积压超过 1MB 时跳过旧的部分。二是 ZCode 渲染层发给主进程的卡片通知：只在被观察的两个通道上包一层监听，原样转交给 ZCode 自己的处理函数，其他通道保持 ZCode 注册的原函数，`removeListener` 不受影响。日志里没有“等待用户”的记录，所以“等你回应”只来自卡片通知，不做推断。
- 不开端口、不起额外进程（桌面模式的页面进程是 Electron 在 ZCode 进程树里起的渲染进程，见第 6 节）、不写 ZCode 的任何文件、不读对话内容（只用事件名、会话 id、工具调用 id 和卡片 id）。
- 各会话分别跟踪，按紧急程度合并成一个状态：等你回应 > 出错 > 干活 > 思考 > 完成 > 待机。“完成”和“出错”只看主会话这一轮的结束；手动停止（`turn.failed` 且 `status` 为 `cancelled`）不算出错；子代理运行时只算干活。回合 10 分钟没有任何事件就当作已经结束。思考、干活、待机之间的切换至少保持 1.5 秒，避免闪烁。
- “等你回应”：卡片弹出即进入，按卡片 id 去重，多张卡片全部处理完才退出。同一 id 的 `tool.permission.resolved` 出现即退出（回答、批准、拒绝、自动作答都会写）；这一轮结束时清掉该会话的卡片；id 不是 `perm_` 开头的卡片没有对应日志，在该会话的下一条事件时退出；4 小时兜底。ZCode 不发通知的情况就不提醒：卡片在没打开的会话里、切到会话时卡片已经存在、设置里关闭了“通知”、卡片已在时刷新或重启。
- 读不懂的行直接忽略；跟随出错时每种错误只写一次 `runtime.log`。旧版主进程没有桌宠通道时，新版 preload 的请求被拒绝，桌宠不出现，其他功能照常。
- 窗口内的位置是本地 UI 偏好（`localStorage` 的 `zcode-canvas:pet:v1`），不写进配置；桌面模式的位置见上。
- 素材随包发布在 `pets/`，`apply` 时部署到运行时目录，以 `file:` URL 加载，不联网。

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

- 不开调试端口，不走 CDP。理由：CDP 注入要求 ZCode 始终由 Canvas 的启动器带着 `--remote-debugging-port` 启动，而 Dock、Spotlight、登录项、更新后的自动重启都会绕过启动器，主题随启动方式时有时无；真机验证过第二实例在建立 renderer target 前就会因 ZCode 的单实例锁退出，连旁路启动都不可行。CDP 也拿不到主进程能力（外观中心面板、菜单栏入口、vibrancy 开关、启动画面），并让调试端口在应用整个生命周期对本地所有进程敞开。而它想避免的代价——ad-hoc 重签名——经真机验证（macOS Tahoe 25.4）不影响登录、钥匙串和启动，实际成本为零。"不改 app"的正解是第 5 节的官方扩展点，不是 CDP。
- 不留常驻进程；只允许一次性的后台助手，任务完成或超时就退出。例外：桌宠桌面模式会在 ZCode 自己的进程树里多一个渲染进程（约 26 MB），随最后一个 ZCode 主窗口页面关闭而销毁，不会比 ZCode 活得更久。
- 不修改官方 renderer 的代码，不向官方命令面板注册命令。
- 不执行、不解包、不修改 Wallpaper Engine 内容，只导入静态图片（GIF 由浏览器自己播放）。
- 官方更新后不自动重新打补丁，由用户重新执行 `zcode-canvas apply`：自动重打要和官方安装器竞争时序，还需要隐藏的后台辅助进程。
- 不联网。

有人提这类需求时，引用本节说明原因。

## 7. 验收方式

- **稳定部分：** 单元测试（`npm test`），加上在隔离沙箱里手动验证：Windows 用 `scripts/sandbox.mjs`，macOS 用 `scripts/sandbox-mac.mjs`。
- 任何时候都不要在开发者自己正在使用的 ZCode 上做这些验证。
