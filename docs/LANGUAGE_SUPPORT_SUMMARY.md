# 语言支持现状与改进建议

## 📊 当前支持状况总结

### ✅ 完美支持 (1/7)
- **TypeScript/JavaScript**: 使用官方 TypeScript Compiler API
  - 完整 AST 解析
  - 精确符号识别
  - 完整导入/导出分析
  - Framework routes 和 tests 识别
  - **能力**: `["symbols", "imports", "exports", "calls", "definitions", "framework_routes", "tests"]`

### 🟡 基础支持 - 正则表达式方案 (4/7)
这些语言使用手写正则表达式，存在明显不足：

#### Python
- ✅ 顶层函数和类
- ❌ 类方法未单独识别
- ❌ 装饰器无法解析
- ❌ 类属性无法识别
- ❌ 类型注解信息丢失
- ❌ 缩进块结束检测不精确

#### Go
- ✅ 函数、方法、类型（struct/interface）
- ✅ 首字母大写判断导出
- ❌ 复杂泛型可能失败
- ❌ 接口方法未单独解析
- ❌ 嵌入字段识别不足

#### Rust
- ✅ 函数、struct、enum、trait、impl
- ✅ pub 判断导出
- ❌ impl 块内的方法未单独提取
- ❌ 宏展开无法处理
- ❌ 生命周期、trait bounds 解析不准

#### Java
- ✅ 类、接口、枚举、方法
- ✅ public 判断导出
- ❌ 注解 (@Annotation) 无法解析
- ❌ 泛型信息丢失
- ❌ 嵌套类识别不准确

### ⚪ 识别但无结构分析 (2/7)
- **Markdown**: 被识别但使用 fallback（80 行分块）
- **JSON**: 被识别但使用 fallback（80 行分块）

### ❌ 完全不支持的常见语言
C, C++, C#, PHP, Ruby, Kotlin, Swift, Scala, Dart, Elixir, Haskell, Clojure, Lua, Shell Script 等

---

## 🎯 Tree-sitter 迁移尝试

### 已完成的工作

1. **架构设计** ✅
   - 创建 `tree-sitter-base.ts` 统一集成层
   - 实现配置驱动的分析器模式

2. **分析器实现** ✅
   - Python Tree-sitter 分析器
   - Go Tree-sitter 分析器
   - Rust Tree-sitter 分析器
   - Java Tree-sitter 分析器

3. **注册表集成** ✅
   - 支持环境变量切换 (`RAGCODE_USE_TREESITTER=true`)
   - 保留正则分析器作为备份

4. **测试用例** ✅
   - Python 测试套件（6 个测试用例）

### 遇到的阻塞问题

#### 依赖版本冲突
```
tree-sitter-python@0.25.0 → 需要 tree-sitter@^0.25.0
tree-sitter-go@0.25.0     → 需要 tree-sitter@^0.25.0
tree-sitter-rust@0.23.2   → 需要 tree-sitter@^0.22.1
tree-sitter-java@0.23.5   → 需要 tree-sitter@^0.21.1
```

**无法找到所有语言包都兼容的 tree-sitter 版本。**

#### Windows 编译失败
```
tree-sitter@0.25.0 编译错误：
- C++20 or later required
- 但 MSVC 2022 强制降级到 C++17
- node-gyp 构建失败
```

---

## 💡 推荐方案

### 🥇 方案 1: 使用 web-tree-sitter (WASM 版本)

**优势：**
- ✅ 无需编译，跨平台
- ✅ 避免原生依赖问题
- ✅ 所有语言支持
- ✅ 性能仍然很好（略低于原生）

**实现步骤：**
```bash
npm install web-tree-sitter tree-sitter-wasms
```

修改 `tree-sitter-base.ts` 使用 WASM API（与原生 API 类似）。

---

### 🥈 方案 2: 优化现有正则分析器

如果 tree-sitter 集成复杂度过高，可以继续优化现有方案：

#### Python 改进
```typescript
// 识别类方法
function extractClassMethods(classBody: string): Method[] {
  const methodPattern = /^\s+def\s+([A-Za-z_]\w*)\s*\(/gm;
  // ...
}

// 识别装饰器
function extractDecorators(line: string): string[] {
  return line.match(/@[\w.]+/g) || [];
}
```

#### Go 改进
```typescript
// 识别接口方法
function extractInterfaceMethods(interfaceBody: string): Method[] {
  const methodPattern = /^\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:\([^)]*\))?\s*$/gm;
  // ...
}
```

#### Rust 改进
```typescript
// 识别 impl 块中的方法
function extractImplMethods(implBody: string, typeName: string): Method[] {
  const methodPattern = /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/gm;
  // ...
}
```

#### Java 改进
```typescript
// 识别注解
function extractAnnotations(line: string): string[] {
  return line.match(/@[\w.]+/g) || [];
}

// 识别嵌套类
function extractNestedClasses(classBody: string): Class[] {
  // ...
}
```

---

### 🥉 方案 3: 混合方案

- **TypeScript/JavaScript**: 继续使用 TS Compiler API（已经完美）
- **Python**: 使用 web-tree-sitter
- **Go/Rust/Java**: 优化正则分析器
- **新语言**: 优先考虑 web-tree-sitter

---

## 📈 改进优先级

### 高优先级（影响最大）
1. **Python 类方法识别** - Python 是最常用的语言之一
2. **Java 注解支持** - 注解在 Spring 等框架中极为重要
3. **Rust impl 方法** - 大部分 Rust 代码都在 impl 块中

### 中优先级
4. Go 接口方法识别
5. 多行函数签名处理（所有语言）
6. 泛型参数解析（Java、Rust、Go）

### 低优先级
7. 装饰器元数据（Python）
8. 生命周期参数（Rust）
9. 嵌套类/结构体

---

## 🚀 立即可行的改进（无需 tree-sitter）

### 1. Python 类方法识别

```typescript
// 在 python-analyzer.ts 中添加
function extractMethodsFromClass(classNode: Declaration, lines: string[]): SymbolNode[] {
  const methods: SymbolNode[] = [];
  const classBody = lines.slice(classNode.startLine - 1, classNode.endLine);
  
  for (let i = 0; i < classBody.length; i++) {
    const methodMatch = /^\s+def\s+([A-Za-z_]\w*)\s*\(/.exec(classBody[i]!);
    if (methodMatch) {
      const methodName = methodMatch[1]!;
      const startLine = classNode.startLine + i;
      const endLine = findMethodEnd(classBody, i);
      
      methods.push({
        id: stableId([repoRoot, file.path, classNode.name, methodName, startLine, endLine, "method"]),
        projectId: file.projectId,
        filePath: file.path,
        name: methodName,
        kind: "method",
        language: "python",
        startLine,
        endLine,
        signature: classBody[i]!.trim(),
        exported: !methodName.startsWith("_")
      });
    }
  }
  
  return methods;
}
```

### 2. Java 注解识别

```typescript
function extractAnnotations(lines: string[], startIndex: number): string[] {
  const annotations: string[] = [];
  let index = startIndex - 1;
  
  while (index >= 0 && /^\s*@[\w.]+/.test(lines[index]!)) {
    const match = /@([\w.]+)/.exec(lines[index]!);
    if (match) annotations.unshift(match[1]!);
    index--;
  }
  
  return annotations;
}
```

---

## 📝 建议

### 短期（1-2 周）
1. **优先优化 Python 分析器**（类方法识别）
2. **添加 Java 注解支持**
3. **改进多行签名处理**
4. **编写回归测试**

### 中期（1-2 月）
5. 尝试 **web-tree-sitter** 集成
6. 基准测试和性能对比
7. 逐步替换正则分析器

### 长期（3+ 月）
8. 扩展语言支持（C/C++、C#、PHP）
9. 完善文档和示例
10. 社区反馈和迭代

---

## 📦 已创建的文件（供参考）

```
src/indexing/analyzers/
├── tree-sitter-base.ts               # Tree-sitter 统一基础层
├── python-treesitter-analyzer.ts     # Python Tree-sitter 实现
├── go-treesitter-analyzer.ts         # Go Tree-sitter 实现
├── rust-treesitter-analyzer.ts       # Rust Tree-sitter 实现
├── java-treesitter-analyzer.ts       # Java Tree-sitter 实现
└── registry.ts                       # 更新支持切换

tests/
└── python-treesitter.test.ts         # Python Tree-sitter 测试

docs/
├── TREE_SITTER_MIGRATION.md          # Tree-sitter 迁移文档
└── LANGUAGE_SUPPORT_SUMMARY.md       # 本文档
```

这些文件可以作为未来实现的参考，或在解决依赖问题后直接使用。

---

## 🤔 需要你的决定

你希望我：

**A. 优化现有正则分析器**（立即可用，渐进改进）
   - 先实现 Python 类方法识别
   - 再添加 Java 注解支持
   - 逐步提升准确率

**B. 继续 Tree-sitter 集成**（长期更优，但需要解决依赖问题）
   - 尝试 web-tree-sitter (WASM)
   - 或在 Linux/macOS 环境测试

**C. 混合方案**（务实平衡）
   - 先优化关键语言的正则分析器
   - 同时研究 web-tree-sitter 可行性
   - 逐步迁移到 tree-sitter

你更倾向于哪个方案？
