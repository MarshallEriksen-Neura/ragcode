# Incremental Indexing Stress Benchmark Results

## 执行时间
2026-06-10

## Benchmark 配置
- Routes: 24 个 API route 文件
- Clients: 96 个 client 组件（调用 API）
- Leaves: 240 个 leaf 文件（无依赖）
- 总文件数: ~365 个文件

## 测试场景与结果

### ✅ route-change（修改现有 route）
- **Changed**: 1 文件
- **Refreshed**: 5 文件（route 自身 + 4 个 direct clients）
- **Elapsed**: ~300-400ms
- **结论**: 只刷新直接依赖，未触发全仓 TS/JS 重分析

### ✅ middleware-change（修改现有 middleware）
- **Changed**: 1 文件
- **Refreshed**: 25 文件（middleware 自身 + 24 个 routes）
- **Elapsed**: ~350ms
- **结论**: 只刷新受影响的 routes，未触发全仓扫描

### ✅ leaf-change（修改 leaf 文件）
- **Changed**: 1 文件
- **Refreshed**: 1 文件（leaf 自身）
- **Elapsed**: ~150ms
- **结论**: 无依赖文件不扩散失效

### ✅ route-added（新增 route）
- **Changed**: 1 文件
- **Refreshed**: 1 文件（新 route 自身）
- **Elapsed**: ~220ms
- **结论**: 新增 route 不触发 client 刷新（已知 correctness hole，需后续修复）

### ✅ middleware-added（新增 middleware）
- **Changed**: 1 文件
- **Refreshed**: 26 文件（middleware 自身 + 25 个 routes，含之前新增的）
- **Elapsed**: ~290-340ms
- **结论**: 新增 middleware 正确触发所有 routes 刷新（语义正确）

## A1 验证结论

✅ **粗失效已消除**: 
- ❌ 旧版：改一个 route → 全仓 TS/JS 重分析（~365 文件）
- ✅ 新版：改一个 route → 只刷新 direct clients（~5 文件）

✅ **middleware 失效收敛**:
- ❌ 旧版：改 middleware → 全 route 扫描（无选择）
- ✅ 新版：改 middleware → 只刷新 routes（~25 文件，语义正确）

⚠️ **已知 Correctness Hole**:
- `route-added` 只刷新 1 个文件，不刷新已有的调用该 URL 的 clients
- `calls_api` 边会永久缺失，直到 client 自己被改或全量重建
- 需要：持久化 `routeUrl → client files` 反向索引（如 review 中指出）

## 性能指标

| 场景 | Changed | Refreshed | Ratio | Elapsed | 通过 |
|------|---------|-----------|-------|---------|------|
| route-change | 1 | 5 | 1:5 | ~350ms | ✅ |
| middleware-change | 1 | 25 | 1:25 | ~350ms | ✅ |
| leaf-change | 1 | 1 | 1:1 | ~150ms | ✅ |
| route-added | 1 | 1 | 1:1 | ~220ms | ✅ |
| middleware-added | 1 | 26 | 1:26 | ~320ms | ✅ |

**全部通过** `--assert` mode，无回归。

## 下一步

1. **修复 route-added correctness hole**: 实现 `routeUrl → client files` 持久化反向索引
2. **添加边数断言**: 验证 `calls_api` 边在各场景下的正确性
3. **纳入 CI**: 将 `npm run benchmark:incremental-stress -- --assert` 加入 audit gate
