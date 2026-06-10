# RagCode TODO

更新时间: 2026-06-10

## 当前状态

A 块和 B 块对应的 performance goals 已完成。下一阶段不继续堆新能力，先做集成收口、全量验收、文档同步和提交切片。

注意: B4 当前落地的是 bounded dynamic dataflow v1，包括同文件 const/template API URL 传播和 ORM 写入的 request payload 来源标注；它不是无限制运行时 taint/dataflow 引擎。未解析的 template URL 不会连接到具体 route。

## A. 性能 / 成本 / 大仓扩展

- [x] A1 affected-file analysis: route/middleware 反向失效索引，消除 route 变更触发全仓 TS/JS 重分析。
- [x] A3 embedding 队列控制: retry/backoff、contentHash 复用、缺失向量补齐、成本控制。
- [x] A5 stress benchmark: 增量索引 stress gate 和失效集大小指标。
- [x] A2 热路径优化: affected refresh 限定扫描、metadata scalar dedupe、增量 scan hot path 收敛。
- [x] A4 LanceDB schema/repair: schema drift repair、seed 清理、谓词 escaping 修复。

## B. 语义质量 / 产品形态硬化

- [x] B1 weighted path search: subgraph traversal 改为邻接索引 + 加权路径选择。
- [x] B2 coverageSummary / why_these_files: 增加 edit-readiness rollup 和文件入选理由。
- [x] B6 output presets: `agent_edit` / `debug_trace` / `review_risk` 差异化输出；MCP 默认保持 compact 兼容形态。
- [x] B3 reuse_guard / normalized duplicate detection: normalized AST body fingerprint、signature similarity、import/callee overlap、可选 `reuseGuard` hard gate。
- [x] B5 framework / ORM resolver: framework resolver plugin 化，保留 Next.js，新增 Express/Fastify route resolver，新增 Prisma/Drizzle ORM resource edges。
- [x] B4 动态 dataflow: bounded const/template API URL propagation 生成 `framework_dataflow`，ORM write edge 标注 `orm_dataflow` request payload 来源。

## 下一阶段 C. 集成收口 / 发布前验收

- [x] C1 full regression: 跑 `npm run check` 和核心 vitest 全套，至少覆盖 indexing、semantic、topology、subgraph、reuse、MCP tools。
- [x] C2 benchmark audit: 运行 A 块 stress/perf benchmark，确认 route/middleware、scan hot path、embedding 调用数没有回退。
- [x] C3 behavior audit: 对 B 块输出抽样，检查 `coverageSummary`、`whyTheseFiles`、presets、reuseGuard、framework/ORM/dataflow metadata 是否符合产品语义。
- [x] C4 docs sync: 更新 README/docs 中 MCP tool 输出、reuseGuard 输入、framework/ORM/dataflow 能力边界。
- [ ] C5 commit slicing: 按能力切片提交，建议顺序为 A performance gates -> B1/B2/B6 -> B3 -> B5 -> B4 -> docs/todo。

## 风险与边界

- B4 只做 bounded static propagation，遇到跨文件变量、运行时拼接、复杂 taint 链仍应降级为不确定证据，不应自信推断；未解析 template URL 不会生成具体 route link。
- B5 已有 Express/Fastify/Prisma/Drizzle golden eval；Hono/Nest/Django/Rails/TypeORM 仍应作为后续 resolver 扩展，不混入当前收口阶段。
- 当前 worktree 仍是未提交状态，下一阶段应完成最终验证和 C5 commit slicing。
