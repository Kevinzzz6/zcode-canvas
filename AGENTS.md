# AGENTS.md

如果你的任务是替用户安装或配置 Canvas，请按 [README.md](README.md) 的「快速开始」操作，下面的规则不适用。遇到需要管理员权限、sudo 或退出 ZCode 的步骤，交给用户完成；不要自己结束 ZCode 进程，你很可能正运行在它里面。

以下规则只针对修改本仓库的代码。

动手之前先读 [docs/design.md](docs/design.md)。它规定了安全底线、各部分的稳定程度、依赖 ZCode 内部实现的清单，以及哪些问题要修、哪些不修。评审意见和改动都以它为准。

- 新增对 ZCode 内部实现的依赖时，同步更新 `docs/design.md` 第 3 节的表格。
- 不要在开发者自己正在使用的 ZCode 上测试。用 `scripts/sandbox.mjs`（Windows）或 `scripts/sandbox-mac.mjs`（macOS）启动隔离副本。
- 提交前运行 `npm run typecheck`、`npm test`、`npm run build`。
- 发布用 `npm publish --ignore-scripts=false`：仓库 `.npmrc` 的 `ignore-scripts=true` 会连 `prepack` 一起跳过，不带这个旗标会把没有 `dist` 的残缺包发出去。
