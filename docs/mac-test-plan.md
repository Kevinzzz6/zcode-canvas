# ZCode Canvas macOS 真机测试计划（草稿，未提交）

> **已执行（2026-09-30，macOS Tahoe / darwin 25.4）：A–E 全部通过，结论为保留 asar patch + ad-hoc 重签方案。**
> 补丁、重签、restore 端到端可用，重签后 `codesign --verify --deep --strict` 通过；无登录或钥匙串弹窗，历史会话保留；
> quarantine + ad-hoc 未复现"已损坏"（含从 DMG 抽取、保留 quarantine 的副本直接启动）；功能清单（热重载、壁纸/GIF、
> 外观中心、菜单栏入口、快捷键、material none）全部验证。CDP spike：调试端口可用，但第二实例在建立 renderer target
> 前会因单实例锁退出，Plan B 旁路成本高。测试中发现两个独立问题——status 误报运行状态（macOS pgrep 未按安装路径
> 匹配）、面板变更 reload 双触发——已分别修复。

目的：macOS 适配至今只有单测。用约一小时验证四件事，结果直接决定架构走向
（保留 asar patch + ad-hoc 重签 vs 切 CDP 无侵入）：

1. 补丁 + 重签流程端到端可用
2. quarantine 雷（"先 patch 后首启"是否判"已损坏"）→ 验证自动清 quarantine 护栏的必要性
3. 重签是否引发 Keychain 弹窗
   （源码结论：ZCode 凭据不经 Keychain——密钥是 `SHA256(env 或 platform:homedir:username)`，
   本体是配置目录下 credentials.json，见 _refs/ZCode credentialCipherProvider.ts；
   唯一暴露面是 Chromium 自动的 OSCrypt cookie 键，最坏是一次授权弹窗）
4. macOS 功能清单

## 准备

- Mac 需要 Node ≥ 20
- 传 `zcode-canvas-0.1.0.tgz` 到 Mac：`npm install -g ./zcode-canvas-0.1.0.tgz`
- 官方 ZCode DMG 安装到 /Applications

## A. 基线取证（改之前）

```bash
codesign -dv --verbose=4 /Applications/ZCode.app 2>&1 | grep -E "Authority|TeamIdentifier|Identifier="
spctl -a -vv /Applications/ZCode.app          # 官方公证状态
```

先正常启动一次 ZCode 并登录（消耗掉 quarantine），然后记录 Keychain 基线：
钥匙串访问搜 "ZCode"（重点找 "ZCode Safe Storage" 这类 Chromium 项），或：

```bash
security dump-keychain login.keychain-db | grep -i -B2 zcode | head -20
```

## B. 补丁 + 重签（核心测试）

```bash
zcode-canvas status
zcode-canvas apply
codesign -dv /Applications/ZCode.app 2>&1 | grep -i signature    # 预期 Signature=adhoc
```

从 Dock 正常启动 ZCode，观察记录：

- [ ] 能启动，主题生效
- [ ] 是否弹 Keychain 授权框（弹了就点"始终允许"，记下是哪个项）
- [ ] 登录态还在（凭据是文件存的，理论上不受影响——验证它）

## C. 二次重签（身份漂移测试）

```bash
zcode-canvas restore
zcode-canvas apply
```

再启动，记录：是否再次弹 Keychain？登录态还在？

判定：每次 apply 弹一次同一项的授权框 = 低痛（写文档说明即可）；
丢登录/丢数据 = 高痛。

## D. quarantine 雷（验证护栏必要性）

```bash
xattr -w com.apple.quarantine "0081;00000000;Safari;" /Applications/ZCode.app
open /Applications/ZCode.app        # 预期：报"已损坏"
xattr -d com.apple.quarantine /Applications/ZCode.app   # 模拟准备实现的自动护栏
open /Applications/ZCode.app        # 预期：恢复启动
```

## E. macOS 功能清单（逐项过）

- [ ] 主题切换 + 热重载（直接改 ~/.zcode-canvas/config.json，看 watcher）
- [ ] 壁纸：面板选图（原生 dialog）、清除、GIF
- [ ] Glass：官方 vibrancy 透出来
- [ ] material: none（唯一走 setVibrancy 的路径）
- [ ] 菜单栏 Appearance Center 入口 + 面板
- [ ] 面板快捷键（before-input-event 在 mac 的行为）
- [ ] `zcode-canvas status` / `restore` 后 ZCode 仍可启动

## F.（可选，10 分钟）CDP spike——只为 Plan B 攒数据

```bash
/Applications/ZCode.app/Contents/MacOS/ZCode --remote-debugging-port=9222 &
curl -s http://127.0.0.1:9222/json | head -40
```

确认端口可用、能看到 renderer target 即可，不做注入。

## G.（可选）更新流程

若 ZCode 有新版本：更新后确认 ①官方签名恢复（codesign -dv）②补丁丢失
③`zcode-canvas status` 如实报告。

## H. 桌宠桌面模式（0.4.0，测试开关）

桌面模式只在 Windows 上开放；macOS 上要用测试开关 `ZCODE_CANVAS_PET_DESKTOP=force` 启动 ZCode 才能打开。
目的：判断 macOS 能不能开放桌面模式，以及开放前还要补什么。约 30 分钟。

### 准备

测试开关从 0.4.1 起才有（0.4.0 里没有）。0.4.1 发布前从源码装：

```bash
git clone https://github.com/Kevinzzz6/zcode-canvas.git && cd zcode-canvas
npm install && npm run build && npm link
```

不想动正在用的 ZCode，就在隔离副本里测（复制一份 ZCode.app，配置、数据和单实例锁都与真机分开，带 `--pet-desktop` 即打开测试开关）：

```bash
node scripts/sandbox-mac.mjs ../_sandbox --pet-desktop     # 第一次会先复制 ZCode.app
export SB="$PWD/../_sandbox/home"
HOME="$SB" ZCODE_CANVAS_HOME="$SB/.zcode-canvas" node dist/cli.js apply --zcode ../_sandbox/ZCode.app
HOME="$SB" ZCODE_CANVAS_HOME="$SB/.zcode-canvas" node dist/cli.js pet on
HOME="$SB" ZCODE_CANVAS_HOME="$SB/.zcode-canvas" node dist/cli.js set pet.desktop true
```

`apply` 后用 `pkill -f "_sandbox/ZCode.app/Contents/MacOS/ZCode"` 结束沙箱副本（按路径匹配，碰不到正在用的 ZCode；别用 Cmd+Q，两个都叫 ZCode，容易退错），再跑一次第一条命令，补丁才生效；之后下面的清单在沙箱副本上过，日志看 `$SB/.zcode-canvas/runtime.log`。在真机上测则继续：

```bash
zcode-canvas --version                  # npm 装的应为 0.4.1 或更新；源码装的在发版前仍显示 0.4.0，以下面 runtime.log 那行为准
zcode-canvas apply
zcode-canvas pet on
zcode-canvas set pet.desktop true
```

**先 Cmd+Q 彻底退出 ZCode**（单实例锁：还开着时，新启动的实例会直接退出），再从终端带开关启动——
从 Dock 或 Spotlight 启动拿不到这个环境变量：

```bash
ZCODE_CANVAS_PET_DESKTOP=force /Applications/ZCode.app/Contents/MacOS/ZCode
```

确认开关生效：`grep "desktop pet" ~/.zcode-canvas/runtime.log` 应看到
`desktop pet forced on by ZCODE_CANVAS_PET_DESKTOP=force; untested on darwin`。外观中心“桌宠”里的
“桌面模式”可以点，下面注明“测试开关已打开……尚未验证”。

### 不带开关时（先测这组，确认默认行为）

从 Dock 正常启动：

- [ ] “桌面模式”两个按钮是灰的，提示“只支持 Windows……macOS 尚未验证”
- [ ] 即使 `pet.desktop` 是 true，狐娘仍在窗口里，没有独立窗口
- [ ] 窗口内桌宠：拖动吸附、靠左转身、点击 Q 弹和气泡、透明处点击落到 ZCode、重启后位置还在
- [ ] Cmd+= 放大 ZCode 后拖动，狐娘仍紧跟鼠标

### 带开关时：显示与位置

- [ ] 窗口里的狐娘消失，屏幕右下角出现一只（**真的画出来了**，不是空白：Windows 上实测过隐藏窗口里开始绘制的页面不上屏，所以改成了先显示再加载）
- [ ] 背景完全透明，没有阴影、边框或白底
- [ ] 置顶：盖在其他 app 窗口上面；也看一下她和菜单栏、Dock 的上下关系
- [ ] Retina 屏下清晰、大小正常；外接显示器（如有）上拖过去再拖回来，位置正确
- [ ] 拖到屏幕边缘附近会吸附，靠左边缘时转身；松手后 `cat ~/.zcode-canvas/pet-position.json` 记的是离边缘的距离
- [ ] 退出重开后回到原位

### 点击与焦点

- [ ] 只有她身上不透明的地方能点：点她会 Q 弹、冒气泡；点她周围透明的地方，点击落到下面的窗口
- [ ] 光标停在她身上不动时，点击仍然点中她（不是穿过去）
- [ ] 在别的 app（比如访达）里点她或拖她：焦点留在原 app，ZCode 不会被激活到前台
- [ ] 气泡打开时点气泡会关掉它
- [ ] 活动监视器里看 CPU：光标在她附近来回移动时没有明显升高

### 截图

- [ ] Cmd+Shift+3 / Cmd+Shift+4 截屏，截图里**没有**她（setContentProtection）
- [ ] 录屏（Cmd+Shift+5）同样看不到她

### 最小化、隐藏和“等你回应”

- [ ] ZCode 窗口最小化到 Dock（Cmd+M）：她还在
- [ ] Cmd+H 隐藏 ZCode：她还在
- [ ] 窗口最小化时让 AI 跑一个需要批准的命令：她跳起来、冒 `!`（ZCode 设置里的“通知”要开着）
- [ ] 切到别的桌面空间（Space）或全屏 app：**预期看不到她**（代码没有设 `setVisibleOnAllWorkspaces`）——记下实际表现，这是开放前最可能要补的一条

### 关窗、重开与退出（最重要）

macOS 关掉最后一个窗口时 app 不退出，这里和 Windows 完全不同：

- [ ] 关掉 ZCode 的窗口（红色按钮 / Cmd+W）：她**立即消失**，不能剩她一只在屏幕上
- [ ] 点 Dock 图标重开窗口：她回来
- [ ] Cmd+Q：ZCode 立即退出，没有卡住，活动监视器里没有残留的 ZCode 进程
- [ ] 从 Dock 右键“退出”：同上
- [ ] 打开两个 ZCode 窗口（如支持）：只有一只狐娘；关掉其中一个她还在，全部关掉她消失

### 收尾

```bash
zcode-canvas unset pet.desktop      # 或在外观中心切回“关”
```

之后从 Dock 正常启动即可回到默认（不带开关就不会启用）。把每项结果和 `~/.zcode-canvas/runtime.log` 里
`desktop pet` 相关的行发回来；看不到她、点不中、关不掉这三类问题请附截图以外的描述（截图里本来就没有她）。

## 结果 → 决策

| 结果 | 动作 |
|---|---|
| B/C 无弹窗或低痛 | 保留现架构；实现 xattr 自动清理 + `codesign --verify` 自检护栏，macOS 转正 |
| C 高痛（丢登录/丢数据） | 先试自签名证书（身份稳定、改动小），仍不行再评估 CDP |
| B 起不来 | 发我 Console.app 或 `log stream --predicate 'process == "amfid"'` 输出，属 resign 流程 bug |
| E 有功能缺口 | 逐条记 issue，Windows 侧修 |

全程可逆：`zcode-canvas restore` 或重装 ZCode 都能回到官方状态
（签名除外——ad-hoc 之后只有重装/更新才回官方签名）。
