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

## D. 代码审计发现修复 (2026-06-10)

审计范围: framework/orm/reuse topology、embedding/LanceDB、增量索引/调度、graph rerank/subgraph builder。按优先级修复。

优先级 1 — 正确性 (改动小、收益高):
- [x] H1 framework dataflow 作用域污染: collectStringConstants 用扁平 Map 收集全文件 const，同文件不同函数的同名局部 const 后者覆盖前者，urlFromExpression 据此生成标记为 framework_dataflow (高置信) 的错误 route link，违反 B4 "不确定降级" 边界。修复: 同名冲突 (不同值) 降级为不解析，仅信任无歧义绑定。
- [x] M1 embedding retry 失效: requestEmbeddings 抛普通 Error 不带 status，isRetryableEmbeddingError 的 status 检查永不命中，5xx/429 可能不重试；网络错误 code 在 cause.code 也读不到。修复: 抛错附加 status、重试判定读 cause.code、非 JSON 错误体仍带 status。

优先级 2 — 大仓性能 (A 块扩展目标):
- [x] M3 reuse buildStructureIndex O(symbols×edges): importsForSymbol/calleesForSymbol 每个 symbol 全量扫 edges。修复: edges 按 sourceFile/sourceId 预分组成 Map。
- [x] M2 planChunkEmbeddings N+1 查询: 每个 chunk 单独查 contentHash。修复: 批量拉取本 project contentHash→vector 映射后内存比对。

优先级 3 — 检索 / reuse 质量 (需 eval 验证不回退):
- [x] M4 fingerprint 过度归一化: identifier/literal 全抹，addUser/deleteUser 同 fingerprint，reuseGuard 误伤合法代码。修复: duplicateCount 认定加 callee 重叠 (Jaccard>=0.5) 门槛，仅行为相似才算重复 (+回归测试 activateUser/archiveUser)。
- [~] M8 scoreOwnerIntent: 证据修正 — 这些"过拟合"特例 (commands/-core/collections/operations/packages-*-query) 实为针对真实库布局调优、且被 tests/graph-reranking.test.ts 锁定的启发式，非死代码；只在匹配布局时加分、基本不主动致错。本轮已在 graph-reranker.ts 加文档注释登记为"已知偏差 + 调整须配合 reranking eval"，不删除以免回退测试并降低真实库检索质量。彻底去过拟合 (抽配置层 / 重建基线) 需独立 eval 校准会话。

其余 (按需收口):
- [ ] M5 并发 embed Promise.all fail-fast 丢失已成功 batch -> 成功先落库 / allSettled
- [ ] M6 escapeSqlLiteral 反斜杠转义疑似与 DataFusion 冲突 (Windows repoRoot 失配) -> 验证 DataFusion 字面量语义 + repoRoot 存储格式后修正
- [ ] M7 rerank 每次重建 fileGraph + 全量加载 -> 按 repoRoot+projectId+indexGeneration 缓存
- [ ] L1 index-scheduler deadLetter 文件未清理 failureAttemptsByFile (内存泄漏)
- [ ] L2 axios 静态 URL 误标 framework_wrapper
- [ ] L3 routePathMatches "*" 脆弱死分支
- [ ] L4 prisma/db 实例名硬编码 (文档化边界)
- [ ] L5 refreshFrameworkReverseRelations 与主循环反向失效冗余
- [ ] L6 增量模式 cached 全量加载全图到内存 (架构权衡)

## 风险与边界

- B4 只做 bounded static propagation，遇到跨文件变量、运行时拼接、复杂 taint 链仍应降级为不确定证据，不应自信推断；未解析 template URL 不会生成具体 route link。
- B5 已有 Express/Fastify/Prisma/Drizzle golden eval；Hono/Nest/Django/Rails/TypeORM 仍应作为后续 resolver 扩展，不混入当前收口阶段。
- 当前 worktree 仍是未提交状态，下一阶段应完成最终验证和 C5 commit slicing。
