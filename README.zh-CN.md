<p align="center">
  <img src="docs/images/eeb4a920-7607-41a7-aa2c-1d897a96a1ee.png" alt="RagCode logo" width="180" />
</p>

<h1 align="center">RagCode 上下文引擎</h1>

<p align="center">
  <a href="https://github.com/MarshallEriksen-Neura/ragcode/actions/workflows/ci.yml"><img src="https://github.com/MarshallEriksen-Neura/ragcode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/ragcode-context-engine"><img src="https://img.shields.io/npm/v/ragcode-context-engine.svg" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D24-green.svg" alt="Node >= 24" /></a>
</p>

<p align="center"><a href="./README.md">English</a> · <b>简体中文</b></p>

**RagCode 是面向编码智能体的「可验证上下文层」，且全程在本地运行。**

绝大多数代码智能工具止步于**检索**——把相关代码片段丢给智能体就完事了。RagCode 多走一步：它会告诉智能体**当前掌握的已验证上下文是否足以安全地动手**。每一个回答都附带明确的来源引用、新鲜度、归属链、影响半径（blast-radius）、覆盖信号（coverage），以及一个 `edit-readiness` 判定（`safe_to_edit_after_reading` / `investigate_only` / `not_enough_context`）——并诚实地记录还缺哪些证据。

它**与编辑器无关、MCP 原生**（Claude Code、Codex，或任何 MCP 客户端——不绑定单一编辑器），并**完全在你的机器上运行**（无需账号、无需 API key、代码不出本地）。首次运行用确定性嵌入即可离线工作；只有当你想要更好的召回时，才需要换上 OpenAI 兼容的嵌入provider。

它借鉴了 CodeGraph、Understand-Anything 等项目的思路，并在此基础上加入了 LanceDB 语义层以及更强的上下文引擎契约：`get_context` 返回的是当前已索引的、能够帮助智能体回答、调试、修改或评审代码的**最小任务上下文包**。

---

## 为什么选 RagCode

| 如果你需要…… | RagCode 适合，因为…… |
|---|---|
| 不被单一编辑器锁定的上下文能力 | MCP 原生；适配任意智能体宿主，而非某一个 IDE |
| 代码永不离开本机 | 全本地索引 + 离线嵌入，无云端往返 |
| 让智能体「正确地动手」而非「自信地犯错」 | 带覆盖信号与 edit-readiness 判定的验证式子图，而不是原始片段堆砌 |

---

## 技术栈

| 领域 | 技术 |
|------|-----------|
| 语言 / 运行时 | TypeScript 5.9、Node.js **>= 24**（使用 `node:sqlite`）、ESM 模块 |
| 结构化图存储 | `better-sqlite3`（SQLite + FTS），测试场景下使用内存存储 |
| 语义 / 向量存储 | `@lancedb/lancedb` + `apache-arrow`，并提供内存存储兜底 |
| AST / 解析 | TypeScript Compiler API（TS/JS）、`tree-sitter`（Python、Go、Rust、Java） |
| MCP 集成 | `@modelcontextprotocol/sdk`（stdio 服务） |
| CLI | `commander`、`ink` + `react`（交互式向导） |
| Web 仪表盘 | `express` + `ws` 后端，Vue 前端（位于 `web/`） |
| 文件监听 | `chokidar` |
| 校验 | `zod` |
| 工具链 | `tsx`（开发）、`vitest`（测试）、`tsc`（构建 + 类型检查） |

---

## 项目架构

RagCode 采用分层设计，任何具体的存储实现都不会跨越边界泄漏。所有对外的接口层（CLI、MCP、Web）都依赖 `src/core` 中的契约，而不依赖任何特定数据库。

```
            ┌──────────┐   ┌──────────┐   ┌──────────────┐
 接口层      │   CLI    │   │   MCP    │   │ Web 仪表盘    │
            └────┬─────┘   └────┬─────┘   └──────┬───────┘
                 └──────────────┴────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  ContextEngine (core)  │  规范契约
                    └───────────┬───────────┘
        ┌──────────────┬────────┼────────┬──────────────┐
        ▼              ▼        ▼         ▼              ▼
   ┌────────┐    ┌─────────┐ ┌──────┐ ┌─────────┐  ┌─────────┐
   │indexing│    │  graph  │ │ sem. │ │retrieval│  │ context │
   │  扫描  │    │ SQLite  │ │Lance │ │ 规划器  │  │  打包器 │
   │  分块  │    │  +FTS   │ │  DB  │ │ +融合   │  │ +预算   │
   └────────┘    └─────────┘ └──────┘ └─────────┘  └─────────┘
                                │
                          ┌─────▼─────┐
                          │   watch   │  增量新鲜度
                          └───────────┘
```

**各层职责**（详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）：

- **core** — 规范契约：`RepoIndex`、`CodeFile`、`CodeChunk`、`GraphStore`、`SemanticStore`、`ContextEngine`。这是其他一切所依赖的稳定边界。
- **indexing** — 文件系统扫描、忽略规则、哈希计算、分块以及索引流水线步骤。它不感知 MCP。
- **graph** — 精确的代码结构：文件、符号、边、查找、调用方/被调用方/影响分析。测试用内存实现，生产用 SQLite + FTS。
- **semantic** — 嵌入与向量检索，藏在接口之后，因此可以自由替换提供商（确定性、OpenAI 兼容、本地模型）和存储后端。
- **retrieval** — 查询规划：意图识别、图 + 语义检索、分数融合、结果归一化。
- **context** — 面向智能体的输出：在字符/Token 预算内挑选片段，附带理由、分数、来源引用以及 `missingEvidence`。
- **watch** — 长时间运行的监听器、持久化事件日志、脏文件合并，以及后台批量重建索引调度。
- **mcp** — 轻薄的协议适配层：工具命名、输入校验、处理器分发。这里不包含任何检索逻辑。

**上下文包契约**是整个引擎的核心。`get_context` 返回：

```
brief → freshness → ownerChain → topology → 证据片段 → missingEvidence → nextQueries
```

片段是*证据*，而非结果的主要组织方式。大文件默认以 `skeleton`（骨架）展开级别返回，而非完整源码，并且每个片段都会报告省略了多少行。

---

## 快速开始

### 前置条件

- **Node.js >= 24.0.0**（必需——SQLite 图存储使用 `node:sqlite`）
- Windows、macOS 或 Linux
- 约 100 MB 磁盘空间，用于依赖与索引数据

### 安装并运行（终端优先、离线优先）

首次运行无需任何嵌入 API key、无需账号、无需托管服务。

```bash
# 全局安装
npm install -g ragcode-context-engine

cd my-project
ragcode init          # 离线优先配置：sqlite + lancedb + 确定性嵌入
ragcode index .       # 构建结构化 + 语义索引
ragcode setup-mcp     # 为你的智能体客户端注册 MCP 服务
```

或者免安装直接试用：

```bash
npx ragcode-context-engine index .
npx ragcode-context-engine search . "query"
```

从源码开发（未全局安装）？用 dev 脚本运行任意命令——它通过 `tsx` 直接执行 TypeScript 入口：

```bash
npm run dev -- index .
npm run dev -- setup-mcp --client codex --print
```

### 升级语义召回能力（可选，永不阻塞）

```bash
ragcode configure          # 编辑存储 / 提供商 / 模型 / base URL / 维度
ragcode configure --test   # 验证提供商（失败分类清晰；绝不打印密钥）
```

要使用 OpenAI 兼容的提供商，设置嵌入提供商及 key：

```bash
export RAGCODE_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=your-api-key
```

### CLI 命令

```bash
ragcode init [directory]            # 初始化配置（交互式向导）
ragcode index <repoRoot>            # 索引一个仓库
ragcode search <repoRoot> <query>   # 搜索代码
ragcode status <repoRoot>           # 检查索引状态
ragcode context <repoRoot> <query>  # 构建上下文包
ragcode mcp                         # 启动 MCP 服务（stdio）
ragcode setup-mcp                   # 为 Claude Desktop 注册 MCP
ragcode doctor [repoRoot]           # 运行时诊断
ragcode watch <repoRoot>            # 文件监听守护进程
ragcode dashboard                   # Web 可观测后端（端口 3000）
```

运行 `ragcode --help` 或 `ragcode <command> --help` 查看更多细节。

### MCP 服务集成

RagCode 可作为 MCP 服务运行，让 Claude 等智能体直接调用它的工具。按客户端自动注册：

```bash
ragcode setup-mcp                       # Claude Desktop  (~/.../claude_desktop_config.json)
ragcode setup-mcp --client claude-code  # Claude Code     (项目 ./.mcp.json)
ragcode setup-mcp --client codex        # Codex CLI        (~/.codex/config.toml)
ragcode setup-mcp --client codex --print # 仅打印配置，不写文件
```

既有配置会被原地合并（保留其它服务和无关字段，并在覆盖前备份原文件）。加 `--force`
可跳过提示直接覆盖已有的 `ragcode` 条目，加 `--include-secrets` 可写入真实 API 密钥而非脱敏占位符。

或手动添加到你的 MCP 客户端配置：

```json
{
  "mcpServers": {
    "ragcode": {
      "command": "ragcode",
      "args": ["mcp"],
      "env": {
        "RAGCODE_GRAPH_STORE": "sqlite",
        "RAGCODE_SQLITE_PATH": ".ragcode/graph.sqlite",
        "RAGCODE_SEMANTIC_STORE": "lancedb",
        "RAGCODE_LANCEDB_URI": ".ragcode/lancedb",
        "RAGCODE_EMBEDDING_PROVIDER": "deterministic"
      }
    }
  }
}
```

**可用的 MCP 工具（共 19 个）：**

- *索引生命周期* — `index_repo`、`refresh_index`、`index_status`、`record_file_events`、`watch_status`
- *搜索与上下文* — `search_code`、`get_context`、`topology_map`、`expand_node`
- *符号与文件* — `find_symbol`、`explain_file`、`find_owner`、`find_reuse_candidates`
- *影响与流向* — `impact_analysis`、`explain_impact`、`related_tests`、`trace_flow`、`trace_request_flow`
- *评审* — `review_diff`

`watch_status` 是只读的：它报告是否有活着的 watcher 在保持索引新鲜，但绝不启动 watcher（启动属于 `ragcode watch` 或 OS 服务的职责）。

### Web 仪表盘（观测与调试）

仪表盘是 RagCode 的可观测面板——图可视化、搜索调试、上下文包检视、监听器监控，以及一个带逐字段来源标注和密钥脱敏的运行时配置视图。配置与设置仍然留在终端中完成。

```bash
ragcode dashboard       # 后端 API（端口 3000）
cd web && npm run dev   # Vue 前端（端口 5173，开发模式）
```

详见 [docs/DASHBOARD.md](docs/DASHBOARD.md) 与 [web/README.md](web/README.md)。

---

## 项目结构

```
ragcode/
├── src/
│   ├── core/          # 规范契约与编排门面（稳定边界）
│   ├── indexing/      # 扫描、忽略规则、哈希、分块、分析器、流水线
│   ├── graph/         # 结构化代码图：符号、文件、边、查找
│   ├── semantic/      # 嵌入 + 向量存储（LanceDB / 内存）
│   ├── retrieval/     # 查询规划与混合（精确/图/关键词/语义）融合
│   ├── context/       # 在 Token/字符预算内构建上下文包
│   ├── subgraph/      # 经验证的代码子图（影响 / 流程 / 评审 / 调试）
│   ├── topology/      # 框架 + 数据流拓扑边
│   ├── reuse/         # 复用 / 重复检测
│   ├── lsp/           # LSP 辅助的符号解析
│   ├── watch/         # 监听守护进程、事件日志、脏文件合并、调度器
│   ├── mcp/           # MCP 工具定义与处理器（轻薄适配层）
│   ├── cli/           # 命令入口（commander + ink 向导）
│   ├── web/           # 仪表盘后端（express + ws）
│   ├── config/        # 运行时配置解析
│   ├── project/       # 项目身份与工作区自动作用域
│   ├── diagnostics/   # Doctor / 冒烟检查
│   ├── types/         # 共享类型声明
│   └── utils/         # 小型共享工具（非领域所有者）
├── tests/             # Vitest 回归测试套件（基础、图、检索、监听……）
├── docs/              # 架构笔记、契约与决策记录
├── integrations/      # Codex/OMX 智能体技能模板（ragcode-context）
├── scripts/           # init-config、setup-mcp、基准测试、评估、审计
├── web/               # Vue 仪表盘前端
└── benchmarks/        # 基准测试夹具与结果
```

---

## 核心特性

- **混合检索** — 融合精确、图、关键词与语义信号，再应用按模式的加权与图距离重排。最终分数非正的候选会被过滤掉。
- **模式感知的上下文打包** — 从查询中解析检索模式：`debug`、`feature`、`refactor`、`review` 或 `explain`，每种模式优先关注不同类型的证据。
- **上下文包契约** — `brief`、`freshness`、`ownerChain`、`topology`、证据片段、`missingEvidence` 以及 `nextQueries`，附带来源引用与省略统计。返回不确定性，胜过夸大其词。
- **结构化代码图** — 符号、文件，以及 `contains` / `imports` / `exports` / `calls` 边，由 SQLite + FTS 或内存存储支撑。
- **框架 + 数据流拓扑** — 有界的路由/ORM 证据（Next.js、Express、Fastify、Prisma、Drizzle），以 `calls_api`、`routes_to`、`reads_from`、`writes_to` 以及请求负载 `orm_dataflow` 边的形式产出。
- **多语言分析** — 通过 TS Compiler API 对 TypeScript/JavaScript 提供完整 AST 支持；通过 tree-sitter 对 Python、Go、Rust、Java 进行分析，其他文件类型则回退到按行分块。
- **增量新鲜度** — chokidar OS 监听 → 持久化事件日志 → 脏文件合并 → 后台批量重建索引。重启时回放日志，确保脏文件工作不丢失。
- **离线优先** — 确定性嵌入无需 API key；任何时候都能换成 OpenAI 兼容的提供商，无需重构架构。
- **MCP 原生** — 19 个智能体工具运行在轻薄的 stdio 服务之上（索引生命周期、搜索/上下文、影响/流向、评审），外加一个 Codex/OMX 技能模板，引导智能体优先走 MCP、CLI 兜底。
- **Web 可观测性** — 图可视化、搜索调试器、上下文包检视器、监听器监控，以及脱敏的运行时配置视图。

---

## 开发流程

克隆并初始化：

```bash
git clone https://github.com/MarshallEriksen-Neura/ragcode.git
cd ragcode
npm install
```

常用任务（npm 是 CI 使用的标准工具链；本地也可用 `bun`）：

```bash
npm run dev -- doctor       # 通过 tsx 从源码运行 CLI
npm run check               # TypeScript 严格类型检查（不产出文件）
npm test                    # 运行 Vitest 测试套件
npm run test:watcher        # 仅运行监听相关测试
npm run build               # 通过 tsconfig.build.json 编译到 dist/
```

**分支策略：** `main` 是受保护的默认分支。在功能分支上工作，并向 `main` 提交 Pull Request——切勿直接推送到 `main`。

**CI**（[.github/workflows/ci.yml](.github/workflows/ci.yml)）会在每次推送和向 `main` 提交 PR 时，在 Node 24 上按顺序执行：`npm ci` → `npm run check` → `npm run build` → `npm test` → `npm pack --dry-run`。所有步骤必须通过才能合并。发布由 [.github/workflows/publish.yml](.github/workflows/publish.yml) 自动化完成。

使用确定性嵌入进行离线冒烟运行：

```bash
export RAGCODE_GRAPH_STORE=sqlite
export RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite
export RAGCODE_SEMANTIC_STORE=lancedb
export RAGCODE_LANCEDB_URI=.ragcode/lancedb
export RAGCODE_EMBEDDING_PROVIDER=deterministic

npm run dev -- doctor . --query "context engine"
npm run dev -- index .
npm run dev -- search . "context engine"
```

---

## 编码规范

- **TypeScript 严格模式。** 任何改动在被视为完成之前，`npm run check`（`tsc --noEmit`）必须零错误通过。
- **全程 ESM。** 包是 `"type": "module"`；使用 ES import/export 以及 `node:` 前缀的内置模块。
- **尊重分层边界。** 依赖 `src/core` 中的契约，而非具体存储。`indexing` 不得感知 MCP；`mcp` 必须保持轻薄、不含检索逻辑；`watch` 只依赖 `ContextEngine` 契约。
- **存储可替换。** 任何触及图或语义存储的代码都要走 `GraphStore` / `SemanticStore` 接口，以便测试和未来的后端能够替换。
- **稳定的 ID 与哈希。** 分块拥有确定性内容哈希与稳定 ID——修改分块或分析器时要保持这一点。
- **在边界处校验输入**，使用 `zod`，尤其是 MCP 工具输入。
- **绝不打印密钥。** 配置视图与提供商测试会对 API key 脱敏；敏感文件（`.env`、密钥、凭据）会从索引中过滤掉。

---

## 测试

测试使用 **Vitest**，位于 [tests/](tests/)（38+ 套件）。它们覆盖整个基础设施：扫描与增量索引、SQLite 与 LanceDB 存储、混合检索与图重排、上下文打包与骨架化、拓扑解析、监听守护进程与日志回放、MCP 服务工具，以及 onboarding/configure CLI 向导。

```bash
npm test                    # 完整套件
npm run test:watcher        # 仅监听守护进程 + 状态测试
npx vitest run tests/foundation.test.ts   # 单个套件
```

当满足以下条件时，基础设施被认为是稳固的：仓库可确定性扫描、分块拥有稳定 ID/哈希、图与语义存储可替换、CLI 与 MCP 调用同一个引擎、严格类型检查通过，并且扫描/索引/搜索/上下文打包都被测试覆盖。任何行为变更都要同步增加或更新测试，并将编写与评审保持为两个独立的环节。

---

## 贡献指南

1. Fork 仓库，并从 `main` 切出一个功能分支。
2. 进行改动，保持在相关层的边界内（参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。
3. 为任何行为变更在 [tests/](tests/) 中增加或更新测试。
4. 推送前在本地运行完整的检查关卡：
   ```bash
   npm run check && npm test && npm run build
   ```
5. 推送你的分支，并向 `main` 提交 Pull Request，附上简明的变更说明与测试情况。

对于智能体辅助贡献，[integrations/codex/skills/ragcode-context/](integrations/codex/skills/ragcode-context/) 中的 Codex/OMX 技能模板会引导智能体优先使用 RagCode 的 MCP 工具，并提供 CLI 兜底与缺失索引恢复——详见 [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md)。

### 更多文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 分层与职责
- [docs/INDEX_SCHEMA.md](docs/INDEX_SCHEMA.md) — 索引 schema
- [docs/DASHBOARD.md](docs/DASHBOARD.md) — Web 仪表盘
- [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md) — Codex/OMX 智能体技能

---

## 许可证

基于 [MIT 许可证](./LICENSE) 发布。Copyright (c) 2026 RagCode Team。
