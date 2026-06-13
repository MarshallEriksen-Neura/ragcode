# RagCode 优化实施计划

> 基于实际使用场景的改进建议与代码现状分析
> 创建时间: 2026-06-13
> 代码审查: 2026-06-13

---

## 📊 现状分析（Code Review）

### 当前架构

**数据流**:
```
MCP Tool (tools.ts)
  → Engine.getContext() (engine.ts:161)
    → ContextBuilder.build() (context-builder.ts:29)
      → selectDiverseSnippets() (context-builder.ts:60)
        → 返回 ContextPack
  → 直接返回给 MCP 客户端（无截断保护）
```

**关键发现**:

1. **budgetChars 有实现但不完整**（context-builder.ts:30-84）
   ```typescript
   const budgetChars = request.budgetChars ?? DEFAULT_BUDGET_CHARS; // 默认 18,000
   if (usedChars + candidate.cost > budgetChars) return; // 只控制 snippet 数量
   ```

   ✅ **做了**: 控制选择多少个 snippet
   ❌ **没做**:
   - 单个 `snippet.content` 可以无限大（整个文件）
   - `estimateSnippetCost()` 只是简单字符串长度，未考虑 JSON 序列化开销
   - 元数据（ownerChain, topology, relationships）不计入 budget
   - MCP 层直接返回，无二次检查

2. **snippet 内容渲染**（snippet-renderer.ts:7-34）
   ```typescript
   function renderContent(hit, expansionLevel, focusLine) {
     if (expansionLevel === "full_body") return hit.chunk.content; // 可能几万行
     if (expansionLevel === "skeleton") return skeletonizeChunk(hit.chunk);
     if (expansionLevel === "file_card") return fileCard(hit);
     if (focusLine !== undefined) return focusedWindow(content, focusLine); // 28行窗口
     return hit.chunk.content; // 默认返回全部
   }
   ```

   ✅ **做了**: 支持多种 expansion level
   ❌ **问题**:
   - `full_body` 和默认分支返回完整内容
   - 没有单个 snippet 的大小上限
   - `focusedWindow` 只在有 focusLine 时生效

3. **ContextPack 结构**（types.ts:269-286）
   ```typescript
   interface ContextPack {
     snippets: ContextSnippet[];      // 主要数据
     ownerChain: OwnerNode[];         // 元数据
     topology: TopologyEdge[];        // 元数据（最多12条）
     relationships: RelationshipEvidence[]; // 元数据（最多12条）
     budgetChars: number;             // 输入预算
     usedChars: number;               // 只计算了 snippet 选择时的成本
   }
   ```

   `usedChars` **只反映了 snippet 选择阶段的累计**，不是最终 JSON 大小。

### 根本原因

**为什么会 3.3MB**:
1. 单个 `snippet.content` 没有大小限制（可能是整个 10,000 行的文件）
2. `estimateSnippetCost()` 低估了实际大小（未考虑 JSON 开销）
3. 多个大文件的 snippet 累加后超过预算
4. MCP 工具层无二次检查，直接序列化返回

---

## 🚨 P0 - 必须立即修复（影响可用性）

### 1. 严格遵守 budgetChars 限制

**实现方案**（3个文件修改）:

#### A. snippet-renderer.ts - 添加内容截断
```typescript
// 新增：单个 snippet 最大限制
const MAX_SNIPPET_LINES = 150;
const MAX_SNIPPET_CHARS = 8000;

function renderContent(hit, expansionLevel, focusLine): string {
  let content = /* ...现有逻辑... */;

  // 新增：强制截断过大内容
  return truncateContent(content, MAX_SNIPPET_LINES, MAX_SNIPPET_CHARS);
}

function truncateContent(content: string, maxLines: number, maxChars: number): string {
  if (content.length <= maxChars) {
    const lines = content.split(/\r?\n/);
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + '\n... [truncated]';
  }
  return content.substring(0, maxChars) + '\n... [truncated]';
}
```

#### B. context-builder.ts - 更准确的成本估算
```typescript
function estimateSnippetCost(snippet: ContextSnippet): number {
  // 考虑 JSON 序列化开销（引号、转义、字段名）
  const jsonOverhead = 1.3; // 约增加 30%
  const baseSize = snippet.filePath.length + snippet.reason.length + snippet.content.length;
  const fieldOverhead = 200;

  return Math.ceil(baseSize * jsonOverhead) + fieldOverhead;
}
```

#### C. tools.ts - 添加最终输出验证
```typescript
case "get_context": {
  const input = GetContextInput.parse(rawInput);
  const pack = await engine.getContext(input);

  // 新增：验证最终大小
  const serialized = JSON.stringify(pack);
  const actualSize = serialized.length;
  const budget = input.budgetChars ?? 18000;

  if (actualSize > budget * 1.2) {
    return truncateContextPack(pack, budget);
  }

  return pack;
}

function truncateContextPack(pack: ContextPack, budget: number): ContextPack {
  const truncated = { ...pack };
  let currentSize = JSON.stringify({ ...pack, snippets: [] }).length;

  const sortedSnippets = [...pack.snippets].sort((a, b) => b.score - a.score);
  truncated.snippets = [];

  for (const snippet of sortedSnippets) {
    const snippetSize = JSON.stringify(snippet).length;
    if (currentSize + snippetSize > budget * 0.9) break;

    truncated.snippets.push(snippet);
    currentSize += snippetSize;
  }

  truncated.missingEvidence = [
    ...pack.missingEvidence,
    `Output truncated: ${truncated.snippets.length}/${pack.snippets.length} snippets to fit ${budget} char budget.`
  ];

  return truncated;
}
```

**验证标准**:
- [ ] `JSON.stringify(result).length ≤ budgetChars * 1.2`
- [ ] 单个 `snippet.content ≤ 8000 chars` 或 `150 lines`
- [ ] 超出时 `missingEvidence` 包含截断说明
- [ ] 添加测试：`tests/budget-enforcement.test.ts`

**预计工时**: 1.5 天

---

### 2. 添加 Markdown 输出格式

**实现方案**:

#### A. 新增 src/context/markdown-formatter.ts
```typescript
import type { ContextPack } from "../core/types.js";

export function formatContextAsMarkdown(pack: ContextPack): string {
  const sections: string[] = [];

  // Header
  sections.push(`## ${pack.query}`);
  sections.push(`**Confidence**: ${pack.confidence} | **Mode**: ${pack.mode}`);
  sections.push('');
  sections.push(pack.brief);
  sections.push('');

  // Primary Files
  if (pack.ownerChain.length > 0) {
    sections.push(`### 📁 Primary Files (${pack.ownerChain.length})`);
    sections.push('');
    pack.ownerChain.slice(0, 5).forEach((owner, i) => {
      sections.push(`${i + 1}. **[${owner.filePath}](${owner.filePath})** (score: ${owner.score.toFixed(1)})`);
      sections.push(`   ${owner.reason}`);
      if (owner.symbols.length > 0) {
        const symbolNames = owner.symbols.slice(0, 3).map(s => s.name).join(', ');
        sections.push(`   Symbols: ${symbolNames}${owner.symbols.length > 3 ? '...' : ''}`);
      }
      sections.push('');
    });
  }

  // Code Snippets
  if (pack.snippets.length > 0) {
    sections.push(`### 💻 Code Snippets (${pack.snippets.length})`);
    sections.push('');

    const byFile = groupByFile(pack.snippets);
    for (const [filePath, snippets] of byFile.entries()) {
      sections.push(`#### [${filePath}](${filePath})`);
      sections.push('');

      snippets.forEach(snippet => {
        const lang = detectLanguage(filePath);
        sections.push(`**${snippet.role}** (L${snippet.startLine}-L${snippet.endLine})`);
        sections.push(`\`\`\`${lang}`);
        sections.push(snippet.content);
        sections.push('```');
        sections.push('');
      });
    }
  }

  // Topology
  if (pack.topology.length > 0) {
    sections.push('### 🔗 Call Graph');
    sections.push('');
    sections.push('```');
    pack.topology.slice(0, 10).forEach(edge => {
      sections.push(`${edge.from} --${edge.edge}--> ${edge.to}`);
    });
    sections.push('```');
    sections.push('');
  }

  // Warnings
  if (pack.missingEvidence.length > 0) {
    sections.push('### ⚠️ Limitations');
    sections.push('');
    pack.missingEvidence.forEach(msg => sections.push(`- ${msg}`));
    sections.push('');
  }

  // Footer
  sections.push('---');
  sections.push(`*${pack.usedChars.toLocaleString()}/${pack.budgetChars.toLocaleString()} chars used*`);

  return sections.join('\n');
}
```

#### B. 修改 tools.ts
```typescript
export const GetContextInput = SearchCodeInput.extend({
  budgetChars: z.number().int().positive().optional(),
  format: z.enum(['json', 'markdown']).optional()
});

case "get_context": {
  const input = GetContextInput.parse(rawInput);
  const pack = await engine.getContext(input);

  if (input.format === 'markdown') {
    return {
      format: 'markdown',
      content: formatContextAsMarkdown(pack),
      metadata: {
        query: pack.query,
        confidence: pack.confidence,
        snippetCount: pack.snippets.length
      }
    };
  }

  return truncateIfNeeded(pack, input.budgetChars);
}
```

**验证标准**:
- [ ] Markdown 正确渲染
- [ ] 代码块语法高亮
- [ ] 文件路径可点击
- [ ] 保持 JSON 向后兼容

**预计工时**: 1 天

---

## 🔥 P1 - 重要改进（提升体验）

### 3. 增强相关性推理链

**扩展 SearchHit 类型**:
```typescript
export interface SearchHit {
  // ...现有字段
  reasoning?: {
    matchedTerms?: string[];
    symbolMatches?: Array<{
      symbol: string;
      confidence: number;
      matchType: 'exact' | 'fuzzy' | 'semantic';
    }>;
    graphPosition?: {
      hops: number;
      relationship: string;
    };
  };
}
```

**在 HybridRetriever 中生成**:
```typescript
function enrichReason(hit: SearchHit, query: string): SearchHit {
  const reasoning = {
    matchedTerms: extractMatchedTerms(hit.chunk.content, query),
    symbolMatches: hit.chunk.symbolName ? [{
      symbol: hit.chunk.symbolName,
      confidence: calculateConfidence(hit),
      matchType: determineMatchType(hit)
    }] : []
  };

  const humanReason = generateHumanReason(reasoning, hit);

  return { ...hit, reason: humanReason, reasoning };
}
```

**预计工时**: 2 天

---

### 4. 索引覆盖率指标

**新增 completeness-scorer.ts**:
```typescript
export function assessCompleteness(
  freshness: FreshnessReport,
  snippets: ContextSnippet[],
  query: string
): CompletenessAssessment {
  const likelyRelevantPending = freshness.pendingFiles.filter(path =>
    isLikelyRelevant(path, query)
  ).length;

  if (freshness.graphFresh && freshness.pendingFiles.length === 0) {
    return {
      level: 'high',
      explanation: '✅ All files indexed. Results complete.'
    };
  } else if (likelyRelevantPending > 5) {
    return {
      level: 'low',
      explanation: `🔴 ${likelyRelevantPending} relevant files pending.`,
      recommendation: 'Run `ragcode refresh` and retry.'
    };
  }
  // ...
}
```

**集成到 ContextBuilder**:
```typescript
const completeness = assessCompleteness(freshness, snippets, request.query);

return {
  // ...现有字段
  completeness,
  missingEvidence: [
    ...missingEvidenceFor(snippets, metadata),
    completeness.explanation
  ]
};
```

**预计工时**: 1 天

---

## 💡 P2 - 加分项（提升质量）

### 5. 智能代码片段提取

**改进 expansion-policy.ts**:
```typescript
export function chooseExpansion(chunk: CodeChunk, query: string, mode: ContextMode) {
  const lineCount = chunk.content.split(/\r?\n/).length;

  // 超大文件强制 skeleton 或 focused
  if (lineCount > 200) {
    const focusLine = findBestFocusLine(chunk, query);
    return focusLine
      ? { expansionLevel: "focused_body", focusLine }
      : { expansionLevel: "skeleton" };
  }

  // 中等文件优先 focused
  if (lineCount > 80) {
    const focusLine = findBestFocusLine(chunk, query);
    if (focusLine) {
      return { expansionLevel: "focused_body", focusLine };
    }
  }

  // ...原有逻辑
}
```

**预计工时**: 1.5 天

---

## 🚀 P3 - 长期规划

### 6. 分页与扩展接口

新增 `expand_context` MCP 工具，支持查看完整结果或深入特定文件。

**预计工时**: 3 天

---

## 📊 优先级总结

| 优先级 | 任务 | 工时 | 依赖 | ROI |
|--------|------|------|------|-----|
| **P0.1** | budgetChars 强制 | 1.5d | 无 | ⭐⭐⭐⭐⭐ |
| **P0.2** | Markdown 格式 | 1d | 无 | ⭐⭐⭐⭐⭐ |
| **P1.3** | 推理链 | 2d | 无 | ⭐⭐⭐⭐ |
| **P1.4** | 覆盖率指标 | 1d | 无 | ⭐⭐⭐⭐ |
| **P2.5** | 智能片段 | 1.5d | 无 | ⭐⭐⭐ |
| **P3.6** | 分页接口 | 3d | P0.1 | ⭐⭐ |

**建议迭代**:
1. **Sprint 1 (1周)**: P0 - 修复可用性
2. **Sprint 2 (1周)**: P1 - 提升透明度
3. **Sprint 3 (可选)**: P2/P3 - 长期优化

---

## 🧪 验收标准

```typescript
// 测试 1: Budget 控制
const result = await getContext({ query: "login", budgetChars: 15000 });
assert(JSON.stringify(result).length < 15000 * 1.2);

// 测试 2: Markdown 格式
const md = await getContext({ query: "login", format: "markdown" });
assert(md.content.includes("```typescript"));

// 测试 3: 推理链
const detailed = await getContext({ query: "auth" });
assert(detailed.snippets[0].reasoning?.matchedTerms.length > 0);
```

---

## 📝 开发日志

### 2026-06-13
- ✅ 代码审查完成
- ✅ 识别根本原因
- 📋 待实施

---

## 🔍 相关文件

**需修改**:
- `src/context/snippet-renderer.ts`
- `src/context/context-builder.ts`
- `src/mcp/tools.ts`
- `src/core/types.ts`

**需新增**:
- `src/context/markdown-formatter.ts`
- `src/context/completeness-scorer.ts`

**需测试**:
- `tests/budget-enforcement.test.ts`
- `tests/markdown-format.test.ts`
