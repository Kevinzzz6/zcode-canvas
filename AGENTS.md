# AGENTS.md

动手之前先读 [docs/design.md](docs/design.md)。它规定了安全底线、各部分的稳定程度、依赖 ZCode 内部实现的清单，以及哪些问题要修、哪些不修。评审意见和改动都以它为准。

- 新增对 ZCode 内部实现的依赖时，同步更新 `docs/design.md` 第 3 节的表格。
- 不要在开发者自己正在使用的 ZCode 上测试。用 `scripts/sandbox.mjs` 启动隔离副本。
- 提交前运行 `npm run typecheck`、`npm test`、`npm run build`。
