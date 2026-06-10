# Semantic Layer Test Fixes

## 修复时间
2026-06-10

## 问题概述
A/B 块落地后，6 个 semantic layer 测试失败。经过修复，所有 semantic 测试通过，从 6/137 失败降至 2/137（剩余 2 个与 semantic layer 无关）。

## 修复内容

### 1. `__seed__` 行泄漏到 delete 调用
**文件**: `src/semantic/lance-semantic-store.ts:252-261`

**问题**: `deleteFileScopesForChunks` 按 `projectId + filePath` 删除时，`__seed__` 行可能和真实 chunk 重叠，导致额外 delete。

**修复**: 在删除谓词中添加 `AND id != '__seed__'`，避免误删 seed。

```typescript
await table.delete(andPredicate(
  equalsPredicate("projectId", projectId),
  equalsPredicate("filePath", filePath),
  "id != '__seed__'"
));
```

### 2. 错误消息格式变更
**文件**: `tests/semantic-runtime.test.ts:190-193, 222-223`

**问题**: A4 改了错误消息措辞（`"embedding profile mismatch"` → `"requires repair but ... cannot drop/recreate"`），测试正则不匹配。

**修复**: 更新测试正则支持两种格式：
```typescript
.rejects.toThrow(/(embedding profile mismatch|requires repair).*dimensions 32 != 16/i)
```

### 3. seed row 创建逻辑
**文件**: `src/semantic/lance-semantic-store.ts:350-378`

**问题**: `openOrCreateTable` 总是先创建 seed 再删除，导致测试期望的「有真实 rows 时不创建 seed」失败。

**修复**: 当有 `seedRows` 时直接用真实 rows 创建表，不创建 seed：
```typescript
if (seedRows?.length) {
  return db.createTable(this.tableName, seedRows);
}
return db.createTable(this.tableName, [emptySeedRecord(vectorDimensions)]);
```

### 4. `resetRepo` 不创建表
**文件**: `src/semantic/lance-semantic-store.ts:161-169`

**问题**: `resetRepo` 在表不存在时直接返回，导致 seed test 的 `table.seed` 为 `undefined`。

**修复**: 表不存在时创建带 seed 的表：
```typescript
if (!table) {
  const dimensions = this.vectorDimensions ?? 64;
  await this.getTable(dimensions, [emptySeedRecord(dimensions)]);
  return;
}
```

### 5. 测试 `matchesPredicate` 不支持 `!=`
**文件**: `tests/semantic-consistency.test.ts:162-175`

**问题**: mock 的 `matchesPredicate` 只支持 `=`，不支持 `!=` 谓词。

**修复**: 添加 `!=` 支持：
```typescript
const notMatch = /^\s*id\s*!=\s*'([^']*)'\s*$/.exec(clause);
if (notMatch) {
  return record.id !== notMatch[1];
}
```

## 测试结果

**修复前**: 6 failed | 131 passed (137)
- semantic-runtime.test.ts: 4 failed
- semantic-consistency.test.ts: 1 failed  
- lance-semantic-store.test.ts: 1 failed
- cli-persistence.test.ts: 1 failed (超时)

**修复后**: 2 failed | 135 passed (137)
- ✅ semantic-runtime.test.ts: 11/11 passed
- ✅ semantic-consistency.test.ts: 4/4 passed
- ✅ lance-semantic-store.test.ts: 8/8 passed
- ❌ cli-persistence.test.ts: 1 failed (30s 超时，非 semantic 问题)
- ❌ eval/skeletonization.test.ts: 1 failed (评估测试，非 semantic 问题)

## 遗留问题

1. **cli-persistence.test.ts 超时**：30 秒超时，可能是 SQLite 写入卡住或测试逻辑问题，需单独调查。
2. **A1 的 add-side correctness holes**：新增 route/middleware 场景静默丢边，需要后续修复（已在 review 中指出）。
