A. 性能 / 成本 / 大仓扩展
A1. affected-file analysis:已有,但有两个粗失效悬崖
真正的 scale killer 在 indexer.ts:112-122:


// 改一个 middleware → 重新分析“所有” route 文件
if ([...touchedPaths].some(isMiddlewareFile)) { for (file of files) if (isRouteFile) refreshed.add }
// 改一个 route → 重新分析“所有” TS/JS 文件
if ([...touchedPaths].some(isRouteFile)) { for (file of files) if (isTypeScriptLike) refreshed.add }
第二条最致命:碰任意一个 API route 文件,就把全仓 TS/JS 全量重分析。大仓里编辑一个路由 = 退化成全量索引。这是 base case 之外、真实开发里天触发的塌方。

根因:它用「全量重算」来兜底「哪些 client 文件调了这个 route 的 URL」这个反向关系。正确做法是建一个持久化的反向索引 routeUrl → client文件集合(framework-topology 算 cals_api 时本来就知道这个映射),route 变更时只重算命中该 URL 的少数 client,而不是全仓。middleware 那条同理,建 middleware → 受影响 route 映射。

A2. 只重算变更邻居:一跳 + 几个结构性低效
只展开一跳:refreshedFilePaths 只看 previousEdges 里直接指向变更文件的源文件。签名变更的跨文件 ripple 超过一跳就抓不到。可接受的深度取舍,但要在 coverage/missingEvidence 里显式标注「邻居失效仅一跳」,否则会自信地给出过期 call graph。
每次 refresh 全量载入内存:indexer.ts:34-36 把整仓 chunks/symbols/edges 全 load 进来做diff。大仓下这是 O(repo) 内存 + GC 压力,且和 watcher 每个 batch 叠加。
dedupeEdges 用 JSON.stringify(metadata) 当 key(chunker.ts:117-127):每条边一次 stringify,边数上万时是隐藏热点。应改成稳定的标量拼接 key。
scanRepo 每次 refresh 全文件读 + 哈希:和我上一轮提的 computeFreshness 重扫是同一个放大源。watcher 已经知道哪些文件脏了,scan 应该能被 watcher 的 path→hash 镜像增量化,而不是每次遍历全仓。
A3. embedding 队列控制:有批/并发,缺限速/重试/断点
lance-semantic-store.ts:136-170 有 embeddingBatchSize / embeddingConcurrency / maxChunks / onProgress,base 不错。缺口:

无 rate limit:只有并发数,没有 RPM/TPM 令牌桶。带速率限制的 provider(OpenAI 等)会直接 429。
无 retry/backoff:embedChunkBatch 抛错 → upsertChunks 抛错 → indexer.ts:84-88 catch 后整次语义更新静默跳过。一个瞬时 429 = 这批所有 chunk 都没进向量库,而且不报错。
无断点续传:进程中途挂掉,已嵌入的批在 Lance 里,但没有「哪些 chunk 还差嵌入」的 checkpoint。needsRebuild 只看 profile 是否存在(lance:121-123),不会补嵌缺失的洞 → 静默部分索引。
无 contentHash 去重:burst 期间同一文件被反复 refresh,changed chunk 每次都重嵌(花钱)。应按 contentHash 跳过已嵌入内容(内容回退/反复保存场景收益巨大)。
无成本上限:没有 token/调用预算 cap。和 watcher 的「失败紧循环重试」叠加,毒文件能把嵌入账单打爆。
这块要和 A1/A2 联动:先把「变更文件集」收窄,嵌入量才真正下来;否则限速只是把账单摊平,不是降低。

A4. LanceDB schema/repair:只检测不修复 + 几个隐患
只 throw 不 repair:lance:251-262 profile mismatch 直接报错让用户手动清表。缺 doc 承诺的 repair 命令(introspect 表 schema → 自动重建/迁移)。
sed 行污染:建表用 __seed__ 零向量占位(lance:389-405),查询时按 id 过滤掉,但它仍参与索引/距离计算,且默认维度 64 若与真实模型维度不符,首次建表维度就错了。
无 schema introspection:只比对 JSON sidecar,从不读 Lance 实际表结构。列集合漂移检测不到。
谓词转义弱:escapeSqlLiteral 只转单引号(lance:407-409)。Windows 路径里的反斜杠、其它特殊字符进 where 谓词(lance:131-134,200)可能让删除谓词错配 → 删错或删不掉文件向量。
A5. stress benchmark:有 smoke,缺规模与回归阈值
benchmark-perf-smoke 是合成小样。需要:合成大仓生成器(N 文件 / M 边 / 可控扇出)、burst 事件模拟(几千 add/change)、测 refresh 延迟 p50/p95、内存高水位、嵌入调用次数(成本回归指标)、单文件改动的失效集大小(直接验证 A1)。每个指标挂回归阈值,纳入 audit gate。

B. 语义质量 / 产品形态硬化(排在 owner-quality 之后)
B1. weighted path search
subgraph-builder.ts:486-489 的 shortestPath 只按长度选路,不累计边权重。一条高置信长路会输给低置信短路。应改成加权最短路(Dijkstra,权重 = 置信/优先级的逆),edgePriority 已有现成权重可复用。

附带:candidateEdges 每跳全量扫边(builder:145-153),O(hops×edges);贪心逐跳在 MAX_NODES=32 处截断,广度早爆时会丢掉深处的关键边。应预建邻接索引一次,再做带权遍历。

B2. coverageSummary / why_these_files
coverageSignals 已有六项 checklist(不错的底子),但它是平铺的 pass/partial/fail 数组,没有:

coverageSummary:一句话 rollup +「能否安全编辑」判定(edit-readiness verdict)。
why_these_files:每个节点为何入选的聚合理由。现在理由散在各 reason 字段里,没汇总成产品级叙述。 这块和 output presets(B6)是同一层。
B3. reuse_guard / normalized duplicate detection
reuse-detector.ts:238-245 的 duplicateRisk 纯靠分数接近度 + 置信,不比对函数体。两个不同名但实现相同的函数检测不到。symbolSimilarity 是子串 + 硬编码同义词(reuse:197-221),英文、表小、脆。需要:归一化 AST body 哈希(去空白/标识符 → 结构指纹)、import/callee 重叠度、签名相似度;并把 reuse 从「建议」升级成可选的硬 reuse_guard 闸门。

B4. 动态 dataflow
framework-topology 的 calls_api 是字符串字面量 URL 匹配(framework:177-219),动态 URL 退化成带 * 通配的 framework_template,有损。reads_from/writes_to 是静态规则,没有 taint/dataflow 追踪。这是「更高阶能力」,要单独立项,别混进优化。

B5. framework / ORM resolver
目前只有 Next.js(nextRoutePath 硬编码 app/pages/api,framework:120-127,client 检测也是 React 专属启发式(framework:152-154)。缺 Express/Fastify/Hono/Nest/Django/Rails,缺 ORM(Prisma/Drizzle/TypeORM)→ 真实表的 reads_from/writes_to。应抽成「framework rule 模块」插件接口,每框架一个 resolver,各带 golden eval。

B6. output presets
agent_edit / debug_trace / review_risk 目前基本是 stub(只有 compact 真做了裁剪)。要落成差异化叙述契约,且依赖 B2 的 coverageSummary/why_these_files 才有内容可填。

建议的推进顺序
两块的内部优先级:

A 块(让它不贵不慢不抖)——先做,因为决定可用性下限:

A1 路由/middleware 反向索引 — 消掉「改一个 route = 全仓重分析」的塌方,ROI 最高。
A3 embedding retry/backoff + contentHash 去重 + 断点 — 堵住「静默部分索引」和成本失控。
A5 stress benchmark + 失效集大小指标 — 没有它,A1/A2 的收益无法证明也会回退。
A2 内存/dedupe 热点 + scan 增量化、A4 LanceDB repair — 跟进项。
B 块(更高阶能力)——owner-quality 绿之后,按这个序:

B1 weighted path search + B2 coverageSummary/why_these_files + B6 presets 是同一束,一起做,直接提升产品可感知质量。
B3 normalized duplicate detection — 把 reuse 从启发式升级到结构指纹。
B5 framework/ORM resolver 插件化 — 横向扩语言/框架。
B4 动态 dataflow — 最难、最易「自信地错」,放最后,且要先有 B5 的框架规则托底。
一句话:A 块是工程降本,B 块是能力升维。A1+A3+A5 是这一轮性价比最高的三件;B1+B2+B6 是 owner-quality 之后第一个值得做的产品束。

这些放在一起优化 你先进行一下分析 然后定一个 阶段计划

显示更多
22:42
我会按 $performance-goal 的约束先做只读分析：不创建优化 goal、不改代码，先把 A/B 两块拆成可验证阶段和 evaluator。重点是确认哪些是当前真实塌方点，哪些需要先建 benchmark gate 再动。

先核对你点名的 indexer、framework-topology、lance、subgraph-builder、reuse-detector 这些 owner。验证输出会直接决定阶段计划，不用猜。


已运行 3 条命令
A 块证据已经足够：A1/A3/A5 确实应该排第一，但 A1 不能只改 refreshedFilePaths，需要先把 framework topology 产出的 route/client 映射持久化为可查询边/索引。接下来核对 B 块的 path/reuse/preset 现状。


已运行 3 条命令
B 块也验证完了：B1/B2/B6 是可以合并成一个产品质量目标；B3 需要结构指纹，不应该和 A 块混做。现在我整理成阶段计划，每阶段都有 objective、依赖、evaluator、完成定义。

阶段计划已经定型：A 先做可用性下限，B 后做产品能力升维。最后我会明确哪些 performance-goal 应该分别创建，避免一个大 goal 混掉 evaluator。

已处理 6m 30s
结论：这些不应该放在一个 performance-goal 里一次做完。A 块是运行成本和大仓可用性，必须先做并用 stress gate 证明；B 块是检索/输出质量，依赖 owner-quality 已绿，但它的 evaluator 完全不同。

当前事实
你提的 A1 是真实下一号问题。上一轮只把 affectedFiles 传进来了，但 indexer.ts (line 20) 仍然整仓 scanRepo，而 indexer.ts (line 125) 附近的 route/middleware 粗失效会把 route 变更扩大到大量 TS/JS。A3 也真实：Lance 有 batch/concurrency，但没有 rate limit、retry、checkpoint、contentHash 去重。A5 缺失：现在没有能证明“单文件路由变更不会全仓重分析”的 stress benchmark。

阶段 1：A1 + A5，先消除 route/middleware 失效塌方
目标：route/middleware 变更只刷新受影响 client/route 邻居，不再 route 变更触发全仓 TS/JS 重分析。

实现边界：

把 framework-topology 产生的 calls_api / uses_middleware 映射沉淀成可查询的反向索引。
refreshedFilePaths 不再用 “route -> all TS/JS” 兜底，改成 routeUrl -> client files。
middleware 也用 middleware -> route files 映射，而不是全 route 扫。
保留一跳邻居策略，但在 freshness/subgraph missing evidence 里标出“incremental invalidation is one-hop”。
Evaluator：
npm run check && npm run test:watcher && npm run test -- tests/incremental-indexing.test.ts && npm run benchmark:watch-stress -- --assert

新增 benchmark 必须测：

N=10k TS/JS 文件、M 个 route/client edges。
改 1 个 route，refreshedFiles <= direct clients + route + bounded neighbors。
analyzer probe 不能接近全仓。
p95 refresh 时间和 invalidation set size 有阈值。
Stop condition：
改任意单 route 不再刷新全仓 TS/JS；stress gate 记录失效集大小。

阶段 2：A3，embedding 成本与可靠性
目标：429/瞬时错误不导致整批语义索引静默缺洞，重复内容不重复花钱。

实现边界：

embedding provider 外包一层 rate-limited retry queue：RPM/TPM 或最小间隔、并发上限、指数退避、429 识别。
Lance upsert 按 contentHash 去重，已嵌入 chunk 不重复 embed。
增加 per-chunk checkpoint/manifest，needsRebuild 不只看 profile，还能发现缺失 chunk 并补齐。
增加预算 cap：本轮最大 batch 数/最大 chunk 数/最大估算 token，超出时降级并显式报告。
Evaluator：
npm run check && npm run test -- tests/semantic-consistency.test.ts tests/lance-semantic-store.test.ts
再加新的 embedding reliability tests：

provider 前两次 429，最终 retry 成功。
同 contentHash 二次 refresh 不再调用 embed。
中途失败后下一次只补缺失 chunk。
超预算时不无限调用 provider。
Stop condition：
embedding 调用次数成为可断言指标；瞬时 429 不再让整批向量静默缺失。

阶段 3：A5 + A2，stress gate 和热路径降 IO
目标：把性能回归变成 CI/audit 可见，不再靠人工感知。

实现边界：

大仓生成器：文件数、边数、route/client 扇出、middleware 扇出可控。
指标：refresh p50/p95、heap 高水位、analyzed files、loaded graph rows、embedding calls、freshness scan time。
computeFreshness 加短 TTL mtime+size scan cache，watcher 事件失效相关 path。
后续再做 path -> hash 持久镜像；这一步先把查询热路径 O(repo) 读放大压住。
dedupeEdges 从 JSON.stringify(metadata) 换成标量 key 或 normalized metadata key。
Evaluator：
npm run benchmark:perf-smoke && npm run benchmark:watch-stress -- --assert
阈值要包括：单文件 dirty 的 scan/cache 命中率、freshness 查询 p95、heap ceiling。

Stop condition：
indexStatus/search/context 不再每次都无条件全仓读+hash。

阶段 4：A4，Lance repair 和 schema 安全
目标：profile mismatch 不只 throw，能诊断和修复。

实现边界：

ragcode repair-semantic-index 或 ragcode semantic repair。
profile sidecar + Lance table schema introspection 双检查。
去掉或隔离 __seed__ 对真实查询/维度的污染风险。
谓词 builder 收敛到统一 escaping/parameter-like helper，覆盖 Windows path。
Evaluator：
repair command fixture + profile mismatch test + path escaping test。

Stop condition：
常见 profile/schema drift 能一条命令修复，不要求用户手动删表。

阶段 5：B1+B2+B6，产品输出质量束
目标：subgraph 不再只按最短路径和原始字段堆 JSON，而是返回可编辑判断和文件入选理由。

实现边界：

SubgraphBuilder 预建 adjacency index，替代每跳全量扫边。
shortest path 改 weighted path search，低置信短路不压过高置信长路。
增加 coverageSummary：一句话 verdict + enough-for-edit 状态。
增加 why_these_files：按文件聚合 role、edge、confidence、reason。
agent_edit/debug_trace/review_risk presets 真正分流输出，而不是返回 full report stub。
Evaluator：
verified subgraph golden fixtures：

高置信长路径胜过低置信短路径。
output preset 体积/字段契约固定。
why_these_files 覆盖所有核心 nodes。
Stop condition：
B1/B2/B6 作为一个可感知产品切片一起通过，不拆散。

阶段 6：B3，reuse guard 结构化去重
目标：从“相似建议”升级为“重复实现风险闸门”。

实现边界：

normalized AST body fingerprint。
signature similarity。
import/callee overlap。
duplicateRisk 不再只看 top score 接近度。
可选 reuse_guard 模式：高置信复用存在时阻止 implement_new 建议。
Evaluator：
同体不同名、同签不同体、同名不同域负例、私有/未导出降置信。

阶段 7：B5/B4，框架/ORM 和动态 dataflow
最后做。先抽 resolver plugin，再逐框架加 golden eval；动态 dataflow 最容易自信地错，必须等框架规则和负例足够后再碰。

推荐创建的 performance-goal
第一个只建这个：

route-invalidation-stress
目标：消除 route/middleware 增量索引粗失效，并建立大仓 stress gate。

因为 A1 是当前最致命的“改一个 route 退化全仓”问题，而且 A3 的 embedding 成本收益依赖 A1 先把变更集收窄。A1+A5 做完，后续 A3 的调用次数指标才有意义。