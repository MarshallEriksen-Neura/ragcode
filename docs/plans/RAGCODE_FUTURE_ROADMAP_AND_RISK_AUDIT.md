# RagCode Future Roadmap And Risk Audit

更新时间: 2026-06-12

## 结论

RagCode 当前已经不是早期的“代码搜索 + 语义召回”原型，而是一个本地运行的 agent-facing verified context engine。它的核心价值应继续收敛到一个目标: 让编码智能体在动手前拿到最小、可引用、带新鲜度和覆盖信号的代码子图，并明确知道当前证据是否足以安全编辑。

未来规划不应继续堆更多松散工具。正确方向是把现有 CLI、MCP、Dashboard、watcher、benchmark 和 verified subgraph 能力收束成一个稳定产品契约: `find owner -> retrieve verified subgraph -> explain missing evidence -> expand only needed nodes -> run reuse/impact/test gates -> emit edit-readiness`。

## 当前事实基线

本分析只基于当前仓库检查，不包含实现改动。

### 产品定位

- `package.json` 将项目描述为本地代码智能基础层: structural code graph、LanceDB semantic layer、retrieval、context packing、MCP tools。
- `README.md` 明确承诺 fully-local、MCP-native、verified context layer，并把 citations、freshness、owner chain、blast radius、coverage signals、`edit-readiness` 作为核心输出。
- `docs/ARCHITECTURE.md` 明确分层边界: `core` 契约、`indexing`、`graph`、`semantic`、`retrieval`、`context`、`watch`、`mcp`。
- `docs/plans/NEXT_PHASE_STRUCTURED_RELATION_RETRIEVAL.md` 已把产品 wedge 定义为 structured multi-hop relation retrieval，而不是 grep 或普通 RAG。

### 当前实现形态

- `src/core/engine.ts` 是主要编排面: 它解析 workspace/project，连接 graph/semantic/embedding runtime，执行 index/search/context/subgraph/owner/reuse/impact/watch 状态流程。
- `src/core/contracts.ts` 维持稳定边界: `GraphStore`、`SemanticStore`、`ContextEngine` 是外部入口共同依赖的接口层。
- `src/mcp/tools.ts` 是 thin adapter: 工具定义、Zod 输入校验、handler dispatch 均委托给 `ContextEngine` 或 subgraph utilities。
- `src/indexing/indexer.ts` 已支持 changed/deleted file 语义写入、index generation、affectedFiles 和 semantic delete/upsert，但增量分析仍会加载完整 prior graph 快照以保证跨文件关系正确。
- `src/retrieval/hybrid-retriever.ts` 用 keyword + semantic + RRF + graph rerank 融合；semantic 失败会降级为空语义结果并保留 diagnostics。
- `src/context/context-builder.ts` 生成 context pack，包含 brief、freshness、ownerChain、topology、snippets、relationships、nextQueries、missingEvidence，并会报告 stale/pending/burst 情况。
- `src/subgraph/subgraph-builder.ts` 生成 `VerifiedCodeSubgraph`，带 nodes、verified edges、paths、snippets、coverage、coverageSummary、whyTheseFiles、missingEvidence、edit-readiness verdict。
- `src/watch/watch-daemon.ts` 已实现 chokidar watcher、journal replay、dirty buffering、heartbeat、per-repo lock、background scheduler integration。
- `src/cli/index.ts` 暴露 index/search/status/context/owner/reuse/expand-node/explain-impact/trace-request-flow/watch/service/doctor/setup/configure/dashboard 等入口。
- `src/web/server.ts` 将 Dashboard 作为 observability surface，提供 index/status/search/context/graph/impact/trace/reuse/subgraph/watch/config API，并自动索引默认 repo。
- `.github/workflows/ci.yml` 在 Node 24 上跑 `npm run check`、`npm run build`、`npm test`、`npm pack --dry-run`。
- `scripts/benchmark.ts` 已有 multi-repo benchmark/gate 结构，追踪 owner、search、context、semantic participation、topology duplicates 等质量指标。

### 已完成但仍需产品化的基础切片

`docs/todo.md` 显示 A/B/C/D/E/F 多轮性能、语义质量、审计修复和 owner 排名质量优化基本完成。当前状态应理解为“基础能力已经可用”，不是“产品边界已经稳定”。尤其需要注意:

- B4 是 bounded dynamic dataflow v1，不是无限制运行时 taint/dataflow 引擎。
- framework/ORM resolver 已覆盖 Next.js、Express/Fastify、Prisma/Drizzle 等局部能力，但 Hono/Nest/Django/Rails/TypeORM 等仍是后续扩展。
- `findOwner` 已有 production owner 优先和 test intent 区分，但 owner 排名质量需要持续负例 benchmark。
- C5 commit slicing 仍未勾选；发布前历史整理和变更切片仍是显性待办。

## 未来目标

### 一句话目标

把 RagCode 做成编码智能体的本地上下文控制平面: 它不替 agent 写代码，而是在 agent 写代码前证明“该读哪些代码、哪些关系可信、还缺什么证据、是否允许进入编辑”。

### 产品契约

未来稳定契约建议收敛为 6 个动作:

1. `owner`: 找到任务 owner 和候选入口。
2. `context`: 输出最小 context pack，默认不返回大文件。
3. `subgraph`: 用 verified graph 回答 impact / flow / debug / review。
4. `reuse`: 在新增实现前检查复用和重复风险。
5. `expand`: 只扩展已经入选子图的节点。
6. `freshness`: 明确当前索引新鲜度、watcher 状态、dirty/pending/stale/burst 风险。

### 非目标

- 不做云端索引服务作为默认路径；本地、离线优先仍是核心约束。
- 不把 deterministic embedding 宣称为真实语义召回质量；它只是离线 smoke signal。
- 不把 bounded static topology 宣称为完整运行时 dataflow。
- 不让 Dashboard 变成 agent 集成入口；agent 入口应继续是 MCP/CLI。
- 不用更多 heuristic 掩盖 missing evidence；不能高置信解析时应降级。

## 未来实施规划

### Phase 0: 发布前收口和历史整理

目标: 先把当前已经完成的基础能力变成可发布、可回滚、可解释的版本。

工作项:

- 完成 `docs/todo.md` 中 C5 commit slicing 或等价的变更历史整理。
- 对 README、README.zh-CN、docs、web README、MCP skill references 进行一次 API 名称和能力边界同步。
- 明确 `impact_analysis` / `trace_flow` legacy flat tools 与 `explain_impact` / `trace_request_flow` verified tools 的推荐关系。
- 把 bounded dataflow、resolver 支持矩阵、semantic fallback、watcher lifecycle 写成用户可理解的限制说明。

验收:

- `npm run check`、`npm run build`、`npm test`、`npm pack --dry-run` 通过。
- README/docs 不再出现明显的入口/API 漂移。
- 发布说明能解释哪些是 stable contract，哪些是 experimental/hardening。

### Phase 1: 契约统一和输出收敛

目标: 让 CLI、MCP、Dashboard 对同一能力的命名、字段、默认输出和风险语言一致。

工作项:

- 将 `ContextPack` 与 `VerifiedCodeSubgraph` 的 `coverageSummary` / `whyTheseFiles` / `missingEvidence` 语言统一。
- 让 `get_context`、`explain_impact`、`trace_request_flow`、`review_diff` 都能表达相同 edit-readiness 语义。
- 将 output presets 做成真正不同的 agent contracts，而不是仅裁剪字段。
- 为 `semantic.status=failed`、`budget_truncated`、`staleFiles`、`pendingFiles` 定义统一 severity。

验收:

- 同一 repo/query 在 CLI 与 MCP 得到一致的 owner、freshness、missing evidence 解释。
- compact 输出足够 agent 做第一轮判断；expanded 输出只在用户或 agent 明确请求时出现。
- 有测试覆盖低预算截断、semantic failure、dirty file 排除、无测试证据等关键状态。

### Phase 2: 负例优先的质量门槛

目标: 从“能找到正确 owner”升级为“不会自信推荐错误 owner/reuse/path”。

工作项:

- 增加 same-name false positive benchmark: 同名函数、同名 route、同名 service、test fixture 刷分、docs/example 噪声。
- 增加 reuse false-positive / false-negative cases: 相似命名但行为不同、相同 body 但 domain 不同、wrapper 和 adapter 场景。
- 增加 topology negative cases: 动态 URL、跨文件 template、运行时拼接、DI/container、未解析 import。
- 给 `scoreOwnerIntent` 这类 case-aware scoring 加负例护栏，避免继续累积仓库特例。

验收:

- benchmark 不只要求 expected owner 出现，也要求明显错误 owner 不排到高位。
- reuse guard 在高风险误复用时返回 `uncertain` 或 `implement_new`，而不是强行 reuse。
- topology/dataflow 遇到不能证明的路径时写入 `missingEvidence`，不生成 high-confidence edge。

### Phase 3: Watcher 和增量索引生产硬化

目标: 让长时间运行的大仓使用不靠运气，索引新鲜度可观测、可恢复、成本可控。

当前风险来自 `src/indexing/indexer.ts` 和 `src/watch/watch-daemon.ts`: 增量写入已经存在，但分析仍需要完整 prior graph；watcher 已有 journal/heartbeat/lock，但还需要压力恢复和运行手册。

工作项:

- 增加 watcher soak/stress tests: 大量 rename/delete/create、permission error、generated directory churn、Windows path case change。
- 增加 dropped-event reconciliation: burst/dropped 后做 hash scan reconcile，而不是仅依赖 OS event。
- 增加 embedding queue rate limit、retry/backoff、parallel analyzer cap、LanceDB write concurrency cap。
- 将 current full snapshot incremental analysis 演进为 affected-neighbor resolver pass，但必须先由 benchmark 证明收益和不回退。
- 完善 OS service 文档: Task Scheduler/systemd/launchd 安装、锁冲突、heartbeat 诊断、恢复流程。

验收:

- 大规模文件变更不会启动大量独立索引任务。
- watcher crash/restart 后不会混合旧图和新文件内容。
- `index_status` 和 `watch_status` 能清楚区分 clean、dirty、pending、indexing、dead-letter、burst。
- 大仓 benchmark 记录 scan/analyze/write/embedding 分阶段耗时。

### Phase 4: 语言、框架、数据关系扩展

目标: 在不破坏 core contract 的前提下扩展语言和框架，而不是把所有规则塞进一个 topology 文件。

工作项:

- 将 framework resolver 模块化，按 Next.js、Express/Fastify、Hono/Nest、Python FastAPI/Flask、Go HTTP、Rust Axum/Actix、Java Spring 分层。
- 为 Python/Go/Rust/Java 增加 cross-file import/call resolution 和 test topology，而不仅是 tree-sitter syntax extraction。
- 为 ORM/resource edges 增加 TypeORM、SQLAlchemy、GORM、Diesel、JPA 等候选，但每个 resolver 必须有 confidence 和 golden fixtures。
- 数据流继续保持 bounded policy: 只在可证明 const/static/template 场景产生中高置信边，复杂运行时路径进入 missing evidence。

验收:

- 每个新增 resolver 都有 positive + negative fixtures。
- 边的来源能明确区分 AST、LSP、framework_rule、resource_rule、event_rule、heuristic。
- 不同语言能力在 docs 中有 support matrix，不能把 syntax extraction 等同于 full resolver。

### Phase 5: Agent 工作流产品化

目标: 把工具从“能返回 JSON”变成“能稳定指导 agent 下一步”。

工作项:

- 设计 pre-edit gate: owner + reuse + impact + related tests + freshness 必须给出统一 verdict。
- 为 Codex/Claude MCP skill 输出推荐工作流: 先 compact subgraph，再 expand node，再 edit。
- 将 `nextQueries` 从通用字符串升级为结构化 action suggestions: tool、args、reason、blocking/optional。
- 引入 review-risk contract: 对 diff 直接输出 changed owners、blast radius、missing tests、stale index risk。
- Dashboard 继续作为观测面，重点展示 graph/debug/benchmark/watch，不承担 agent orchestration。

验收:

- agent 在普通 feature/refactor/review 任务中能用一轮工具调用判断是否能编辑。
- 如果 verdict 是 `not_enough_context`，输出包含具体下一步工具和参数。
- review_diff 能把 changed files 映射到 verified subgraph 和 related tests，而不是普通 diff 文本总结。

### Phase 6: 运维、发布和兼容性

目标: 让用户可以安装、升级、诊断和迁移，而不需要理解内部存储细节。

工作项:

- 为 SQLite graph schema 和 LanceDB sidecar profile 建立 versioned migration/repair 命令。
- 明确 Node >=24 的 runtime 约束和 fallback 不可用场景。
- 完善 `doctor` 对 graph store、semantic store、embedding provider、watcher liveness、MCP registration 的诊断分级。
- 增加 npm package smoke: 安装后 `ragcode init/index/search/context/mcp` 最小闭环。
- 明确 config source precedence: explicit args、env、`.ragcode/config.json`、default。

验收:

- 老版本 `.ragcode` 状态升级时不会静默读错 schema 或 embedding profile。
- `doctor` 输出能区分 fatal、warning、info，并给出可执行修复命令。
- 发布前 dry-run 包含 CLI、MCP、scripts 和 docs 的最小必要文件。

## 当前主要风险

### R1: 能力叙述超过真实边界

风险: README 和计划文档已经很强，但 B4/dataflow、framework topology、non-TS analyzers 仍是 bounded/base slice。若对外说成完整 dataflow 或 full multi-language intelligence，会造成错误使用预期。

控制: docs 中必须保留 support matrix 和 confidence policy；所有不能证明的边进入 `missingEvidence`。

### R2: heuristic 边和 owner scoring 累积成不可维护特例

风险: owner ranking、framework resolver、reuse detection 都需要启发式。若没有负例 benchmark，会逐步变成针对少量仓库的调参。

控制: 每增加一条 scoring/resolver rule，必须增加至少一个 positive fixture 和一个 false-positive fixture。

### R3: 增量索引正确性和大仓成本冲突

风险: 当前 incremental write 不等于 fully incremental analysis。`RepoIndexer` 为正确性仍加载完整 prior graph，未来大仓可能遇到内存或耗时上限。

控制: 先增加分阶段 benchmark 和 memory metric，再做 affected-neighbor resolver；不能为了性能牺牲 cross-file relation correctness。

### R4: Watcher 是长跑系统，失败模式多

风险: watcher 已有 lock/heartbeat/journal，但长跑场景还有 OS event loss、permission error、rename storm、服务重复启动、heartbeat stale、dirty state 膨胀等问题。

控制: 将 watcher hardening 作为单独发布阶段，增加 soak/stress/restart tests 和 operator docs。

### R5: Semantic store 是 optional acceleration，但用户可能误以为是 source of truth

风险: `HybridRetriever` 在 semantic search 失败时降级为 keyword/graph，但如果 UI/CLI 没有醒目标注，用户可能误读召回质量。

控制: diagnostics 必须在 CLI/MCP/Dashboard 中可见；deterministic embedding 只称为 smoke/offline signal。

### R6: 多入口漂移

风险: CLI、MCP、Dashboard、README、web README、Codex skill references 都描述同一套能力，容易出现命名、参数、端点、能力边界不一致。

控制: 以 `src/mcp/tools.ts` 和 `src/cli/index.ts` 作为 API truth，增加 docs sync check 或 audit script。

### R7: Dashboard 自动索引默认 repo 可能带来观测面副作用

风险: `src/web/server.ts` 启动后会 `ensureEngine()` 并自动索引默认 repo。作为本地工具可接受，但对“只观测不变更”的用户心智有潜在冲突。

控制: Dashboard 文档需明确启动行为；未来可增加 read-only/dashboard-observe mode，避免自动写 `.ragcode`。

### R8: 发布和 schema 迁移风险

风险: SQLite graph、LanceDB profile、`.ragcode/config.json`、watcher state 都是持久状态。缺少 versioned migration 时，用户升级后可能遇到不透明失败。

控制: 在 1.0 前补 migration/repair/doctor gate；schema/profile mismatch 必须 fail closed。

## 未来优化队列

### 高优先级

- 契约统一: `coverageSummary`、`edit-readiness`、`whyTheseFiles`、`missingEvidence` 在所有主工具中一致。
- 负例 benchmark: same-name false positives、test/docs fixture 噪声、reuse 误判、dynamic route 未解析。
- Watcher hardening: restart recovery、dropped-event reconciliation、rate limit、dead-letter 可见性。
- Docs sync: README、中文 README、docs、web README、MCP skill reference 与当前 CLI/MCP API 对齐。

### 中优先级

- Output presets 产品化: `agent_edit`、`debug_trace`、`review_risk` 分别优化字段和摘要。
- `review_diff` 升级为 diff-aware verified subgraph，而非 flat graph review。
- Framework resolver modularization，避免 topology 文件继续膨胀。
- Language analyzer support matrix 和 per-language golden eval。

### 低优先级但重要

- Dashboard read-only mode 和 benchmark visualization。
- SQLite/LanceDB repair CLI。
- MCP response schema versioning。
- Local embedding provider profiles 和真实 embedding eval calibration。

## 推荐近期执行顺序

1. 发布前文档/API drift audit。
2. `npm run check`、`npm run build`、`npm test`、`npm pack --dry-run` 建立当前 release baseline。
3. 补 C5 commit slicing 或 release notes，冻结当前基础切片。
4. 做契约统一小版本: context/subgraph/impact/flow/reuse 输出一致化。
5. 做负例 benchmark 小版本: 先防错，再加 resolver。
6. 做 watcher/indexer hardening 小版本。
7. 再进入多语言/多框架扩展。

## 验证证据

本次审计读取并纳入以下仓库证据:

- `package.json`: 项目描述、scripts、Node >=24、依赖边界。
- `README.md` / `README.zh-CN.md`: 产品定位、架构说明、MCP 工具清单、Dashboard 定位。
- `docs/ARCHITECTURE.md`: 分层所有权和 foundation stop condition。
- `docs/todo.md`: A/B/C/D/E/F 当前状态、已完成事项、剩余 C5、风险边界。
- `docs/plans/NEXT_PHASE_STRUCTURED_RELATION_RETRIEVAL.md`: structured relation retrieval 产品 wedge、base slice 完成状态、未来 hardening 项。
- `src/core/contracts.ts`: `ContextEngine`、`GraphStore`、`SemanticStore` 稳定接口。
- `src/core/engine.ts`: workspace hydration、freshness filtering、search/context/subgraph/reuse/watch 编排。
- `src/mcp/tools.ts`: MCP 工具输入 schema 与 handler 分发。
- `src/indexing/indexer.ts`: incremental indexing、generation、semantic failure fallback、完整 prior graph tradeoff。
- `src/retrieval/hybrid-retriever.ts`: keyword/semantic fusion、semantic failure diagnostics、graph rerank。
- `src/context/context-builder.ts`: context pack、owner chain、topology、freshness、missing evidence。
- `src/subgraph/subgraph-builder.ts`: verified subgraph、coverage signals、edit-readiness、whyTheseFiles。
- `src/watch/watch-daemon.ts`: watcher lock、heartbeat、journal、buffer、scheduler integration。
- `src/cli/index.ts`: CLI/API surface 和 service/watch/config/dashboard commands。
- `src/web/server.ts`: Dashboard backend APIs、WebSocket、auto-index、watch observation daemon。
- `.github/workflows/ci.yml`: CI gate。
- `scripts/benchmark.ts`: benchmark/gate 数据结构。

## 完成停止条件

本规划文档对应的分析任务完成条件:

- 有 repo-local 文档记录未来方向、路线、风险、优化点和验收条件。
- 文档基于当前仓库源码、docs、scripts、tests/CI 证据，而不是只复述旧计划。
- 未修改源码或测试实现。
- 通过轻量文档验证: 文件存在、git diff 可读、`git diff --check` 无 whitespace 错误。

后续真正项目路线的停止条件则应按阶段执行: 每一阶段必须有明确 contract、negative tests、benchmark gate、docs sync 和发布说明，不能只以“功能能跑”为完成标准。
