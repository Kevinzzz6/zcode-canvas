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

## 结果 → 决策

| 结果 | 动作 |
|---|---|
| B/C 无弹窗或低痛 | 保留现架构；实现 xattr 自动清理 + `codesign --verify` 自检护栏，macOS 转正 |
| C 高痛（丢登录/丢数据） | 先试自签名证书（身份稳定、改动小），仍不行再评估 CDP |
| B 起不来 | 发我 Console.app 或 `log stream --predicate 'process == "amfid"'` 输出，属 resign 流程 bug |
| E 有功能缺口 | 逐条记 issue，Windows 侧修 |

全程可逆：`zcode-canvas restore` 或重装 ZCode 都能回到官方状态
（签名除外——ad-hoc 之后只有重装/更新才回官方签名）。
