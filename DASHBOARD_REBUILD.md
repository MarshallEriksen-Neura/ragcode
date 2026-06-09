# RagCode Dashboard 全面重构完成

## 📋 概览

对 RagCode Dashboard 进行了完整的全栈重构，从"功能不好用"的原型升级为功能完整、开发者工具风格的专业代码上下文管理面板。

**改动规模**：
- **后端**：完全重写 `src/web/server.ts` (400+ 行)
- **前端**：重写所有核心文件，新增 6 个视图、设计系统、状态管理
- **API**：从 5 个端点扩展到 20+ 个，完整暴露引擎能力
- **类型安全**：前后端零类型错误，完全对齐 `core/types.ts`

---

## 🎯 修复的核心问题

### 之前的问题
1. **检索页字段错位** — 模板用 `snippet.file` 但后端返回 `filePath`，标题恒为空
2. **ContextPack 99% 数据丢弃** — 只显示 brief 和片段，责任链/拓扑/关系/置信度/追问/缺失证据全部未呈现
3. **代码图谱是坏的** — edges 永远空数组（TODO），节点靠无意义的空查询拉取
4. **实时监控是空壳** — WebSocket 只发 `connected`，未接 watch daemon
5. **配置不持久化** — 保存按钮是 TODO
6. **引擎能力未暴露** — `impactAnalysis`/`traceFlow`/`relatedTests`/`findReuseCandidates`/`verifiedSubgraph` 等核心方法完全没有前端入口

### 现在的状态
✅ **全部修复**，并新增大量高级功能。

---

## 🚀 后端重构（`src/web/server.ts`）

### 新架构
- **共享 Engine 实例** — 全局单例，启动时自动索引 `process.cwd()`，避免"Engine not initialized"空状态
- **完整路由覆盖** — 20+ 个端点，完整暴露 `RagCodeEngine` 公开方法
- **WebSocket 接通 watch daemon** — `onEvent` 推送文件变更，`onStatus` 推送调度器状态
- **配置持久化** — 读写 `.ragcode/config.json`，支持 graphStore/semanticStore/embeddingProvider 运行时切换
- **新增 `engine.graphSnapshot()`** — 一次性返回符号+边，解决图谱空边 bug

### 新增/重写路由

| 路由 | 功能 | 对应引擎方法 |
|------|------|--------------|
| `GET /api/status` | 完整 IndexStatus（freshness/burstMode/分项计数） | `indexStatus()` |
| `GET /api/languages` | 语言分布统计 | `graphSnapshot()` + 聚合 |
| `POST /api/index` | 索引仓库 | `indexRepo()` |
| `POST /api/refresh` | 增量刷新 | `refreshIndex()` |
| `POST /api/context` | **完整 ContextPack**（修复字段） | `getContext()` |
| `POST /api/search` | 原始搜索命中 | `searchCode()` |
| `GET /api/graph` | **真正的图谱**（带边） | `graphSnapshot()` |
| `GET /api/symbol/:name` | 查找符号 | `findSymbol()` |
| `GET /api/file?path=` | 文件详情 | `explainFile()` |
| `POST /api/impact` | 影响分析 | `impactAnalysis()` |
| `POST /api/trace` | 调用链追踪 | `traceFlow()` |
| `POST /api/related-tests` | 相关测试 | `relatedTests()` |
| `POST /api/reuse` | 复用候选 | `findReuseCandidates()` |
| `POST /api/subgraph` | 验证子图 | `verifiedSubgraph()` |
| `GET/POST /api/config` | 配置读写（持久化） | 文件 I/O |
| `GET /api/watch/status` | Daemon 状态 | `daemon.status()` |
| `POST /api/watch/start` | 启动 watch | `daemon.start()` |
| `POST /api/watch/stop` | 停止 watch | `daemon.stop()` |
| `WebSocket /ws` | 实时推送 | `FileWatchDaemon` 事件 |

---

## 🎨 前端全面重做

### 设计系统（`web/src/styles/theme.css`）
- **开发者工具风** — 深色为主（`#0d1117` / `#161b22`），高对比度
- **等宽代码区** — SF Mono / JetBrains Mono / Fira Code 优先
- **语义化 badge/stat/panel 组件** — 统一布局原语，信息密度高
- **紧凑间距** — 适合长时间查看代码上下文
- **边缘着色** — 按 EdgeKind 着色（calls/imports/exports…），语言按标准配色

### 核心文件结构
```
web/src/
├── styles/
│   └── theme.css               # 设计系统 token + 原语
├── stores/
│   ├── repo.ts                 # IndexStatus 共享状态
│   └── watch.ts                # WebSocket 连接 + 事件流
├── composables/
│   └── toast.ts                # 轻量 toast 通知（替代 naive-ui）
├── utils/
│   └── format.ts               # 时间/路径/置信度/风险/颜色工具
├── api/
│   └── client.ts               # 完整类型化 API 客户端（20+ 方法）
├── components/
│   └── ToastDisplay.vue        # Toast 渲染容器
├── views/
│   ├── OverviewView.vue        # 索引概览（替代 DashboardView）
│   ├── ContextView.vue         # 上下文检索（替代 SearchView，完整 ContextPack）
│   ├── GraphView.vue           # 代码图谱（真实边 + 点击交互）
│   ├── ImpactView.vue          # 影响分析 + 调用链 + 测试 + 复用（新增）
│   ├── WatchView.vue           # 实时监控（接通 WS + daemon 控制）
│   └── ConfigView.vue          # 配置管理（持久化生效）
├── App.vue                     # 应用壳（自定义侧栏 + 顶栏状态）
├── main.ts                     # 入口（移除 naive-ui，加载 theme.css）
└── router.ts                   # 路由（6 个页面）
```

### 依赖变更
- **移除** `naive-ui` 全局注册 — 自定义 CSS 设计系统替代
- **保留** `vue` / `echarts` / `axios` / `pinia` / `vue-router`
- **新增** 无（零新增依赖）

---

## 📊 六大视图详解

### 1. OverviewView（索引概览）
**替代** DashboardView

**新增功能**：
- ✅ 四卡统计（文件/符号/chunk/边）
- ✅ **新鲜度面板** — fresh/stale/pending/indexing/skipped 分项显示
- ✅ **语言分布** — 按符号数聚合，带配色
- ✅ **跳过文件列表** — 显示原因（文件过大/二进制/忽略规则）
- ✅ **Stale 文件列表** — 索引与磁盘不一致的文件
- ✅ Burst mode 告警徽章
- ✅ 索引 generation 显示

**交互**：
- 输入路径 → 索引按钮
- 刷新/重新索引按钮

---

### 2. ContextView（上下文检索）
**替代** SearchView，**核心页面**

**完整呈现 ContextPack**：
- ✅ **Header badges** — answerable / confidence / mode / 片段数
- ✅ **Brief** — 简要说明
- ✅ **Owner Chain** — 责任链（role/score/符号列表/reason）
- ✅ **Topology** — 拓扑边（from → edge → to，confidence，按 EdgeKind 着色）
- ✅ **Relationships** — 关系证据（source/kind/target/reason）
- ✅ **Code Snippets** — 代码片段（修复字段：`filePath` / `startLine` / `endLine` / `role` / `score` / `expansionLevel` / `elidedLineCount`，语法高亮）
- ✅ **Next Queries** — 建议追问（**可点击**，一键填充查询框）
- ✅ **Missing Evidence** — 缺失证据列表

**交互**：
- 查询框 + 模式选择 + 预算控制（budgetChars）
- Ctrl+Enter 快捷键
- 字符使用量实时显示（`usedChars / budgetChars`）

---

### 3. GraphView（代码图谱）
**修复空边 bug，新增交互**

**新增功能**：
- ✅ **真实边数据** — 从 `engine.graphSnapshot()` 获取完整边
- ✅ **过滤器** — 按语言/kind/limit 过滤节点
- ✅ **ECharts 力导向图** — 节点按语言着色，边按 EdgeKind 着色
- ✅ **点击交互** — 点击节点 → 侧栏显示详情（signature/exported/文件位置）
- ✅ **缩放/拖拽** — roam 开启
- ✅ **Tooltip** — 悬停显示节点/边详情

**显示指标**：
- 显示节点数 / 总节点数
- 总边数

---

### 4. ImpactView（影响分析）
**全新页面**，整合 4 大高级功能

**功能模块**：

#### 4.1 Impact Analysis（影响分析）
- Risk level（low/medium/high）
- Minimal context pack（角色/文件/符号/reason）
- References（入边/出边/confidence）
- Matched symbols / impacted files 统计
- Next queries

#### 4.2 Trace Flow（调用链追踪）
- 入口符号 → 步骤列表（symbolName / kind / targetName / filePath）
- Truncated 标记
- 空结果友好提示

#### 4.3 Related Tests（相关测试）
- 测试文件列表
- Missing likely tests（可能缺失的测试）

#### 4.4 Reuse Candidates（复用候选）
- Decision（reuse/extend/wrap/implement_new）
- Confidence / duplicate risk
- 候选列表（文件/符号/kind/exported/callers/tests/score）
- Why reuse / reasons
- Next queries

**交互**：
- 单一输入框 + 4 个按钮（Impact / Trace / Tests / Reuse）
- 按钮点击后清空其他结果，只显示当前分析
- Next queries 可点击回填输入框

---

### 5. WatchView（实时监控）
**接通真实 WebSocket + daemon 控制**

**新增功能**：
- ✅ **WebSocket 连接状态** — 实时徽章
- ✅ **Daemon 控制** — Start / Stop 按钮
- ✅ **Daemon 状态面板** — ready/buffered/scheduler 状态（pending/indexing files 数、lastError）
- ✅ **事件流** — 时间线显示文件变更（add/change/unlink）+ watch-status + watch-stopped
- ✅ **事件过滤器** — 按类型过滤（all / file-event / watch-status）
- ✅ **自动重连** — 3 秒后自动重连（WebSocket 断开时）
- ✅ **事件按类型着色** — add=success, change=info, unlink=danger

**交互**：
- Start Watch → 启动 daemon（触发后端 `POST /api/watch/start`）
- Stop Watch → 停止 daemon
- Clear Events → 清空本地事件缓存（保留最近 200 条）

---

### 6. ConfigView（配置管理）
**持久化生效，优化排版**

**新增功能**：
- ✅ **配置持久化** — 保存到 `.ragcode/config.json`
- ✅ **配置路径显示** — 显示 `configPath` 和当前 `repoRoot`
- ✅ **友好说明** — Memory vs SQLite/LanceDB，Deterministic vs OpenAI-compatible
- ✅ **重启提示** — 保存后明确提示"重启服务生效"

**配置项**：
- Graph Store（memory / sqlite）
- Semantic Store（memory / lancedb）
- Embedding Provider（deterministic / openai-compatible）
- SQLite Path
- LanceDB URI
- Embedding Base URL
- Embedding Model

---

## 🔧 技术亮点

### 类型安全
- **前后端零类型错误** — `npm run check` + `vue-tsc --noEmit` 全通过
- **类型完全对齐** — `web/src/api/client.ts` 的 interface 直接从 `src/core/types.ts` 对应
- **编译时防护** — 字段改名/新增 → 编译立刻报错，不会运行时才发现

### 状态管理
- **Pinia stores** — `repo.ts`（IndexStatus 共享）+ `watch.ts`（WebSocket 连接 + 事件流）
- **响应式徽章** — 顶栏实时显示 stale 文件数 + live/offline 状态
- **跨视图共享** — 无需重复请求 `/api/status`

### 性能
- **懒加载路由** — 所有视图 `() => import(...)`
- **共享 ECharts 实例** — GraphView 不重复创建
- **事件流限制** — WatchView 最多保留 200 条事件
- **构建产物** — 147KB 主包 + 1MB ECharts（已提示可拆分）

### 开发体验
- **热重载** — Vite 开发服务器
- **代理配置** — `/api` → `http://localhost:3000`，`/ws` → `ws://localhost:3000`
- **Toast 通知** — 轻量替代 naive-ui 的 `useMessage`
- **格式化工具** — `formatTime` / `shortPath` / `confidenceClass` / `edgeColor` / `langColor`

---

## ✅ 验证结果

### 后端
```bash
npm run check  # tsc --noEmit
✅ 零错误
```

### 前端
```bash
cd web && npm run build
✅ vue-tsc --noEmit 零错误
✅ vite build 成功
✅ dist/ 产物生成（147KB 主包 + 1MB ECharts）
```

### 启动测试
```bash
# 终端 1
npm run web:server
# → 自动索引 process.cwd()
# → http://localhost:3000 API ready

# 终端 2
cd web && npm run dev
# → http://localhost:5173 前端 ready
```

访问 `http://localhost:5173`：
- ✅ 左侧导航正常
- ✅ 顶栏显示仓库名 + 统计
- ✅ Overview 页显示索引状态
- ✅ Context 页可检索，完整显示 ContextPack
- ✅ Graph 页加载真实图谱（带边）
- ✅ Impact 页四大功能正常
- ✅ Watch 页 WebSocket 连接，可启停 daemon
- ✅ Config 页保存配置到 `.ragcode/config.json`

---

## 📂 修改文件清单

### 后端（2 个文件）
- `src/core/engine.ts` — 新增 `graphSnapshot()` 方法
- `src/web/server.ts` — **完全重写**（400+ 行）

### 前端（20 个文件）
**新增**：
- `web/src/styles/theme.css` — 设计系统
- `web/src/stores/repo.ts` — IndexStatus 状态管理
- `web/src/stores/watch.ts` — WebSocket + 事件流
- `web/src/composables/toast.ts` — Toast 通知
- `web/src/utils/format.ts` — 格式化工具
- `web/src/components/ToastDisplay.vue` — Toast 容器
- `web/src/views/OverviewView.vue` — 索引概览
- `web/src/views/ContextView.vue` — 上下文检索
- `web/src/views/ImpactView.vue` — 影响分析（**全新**）

**重写**：
- `web/src/api/client.ts` — 完整类型化（20+ 方法）
- `web/src/App.vue` — 自定义侧栏 + 顶栏
- `web/src/main.ts` — 移除 naive-ui，加载 theme.css
- `web/src/router.ts` — 6 个路由
- `web/src/views/GraphView.vue` — 真实边 + 交互
- `web/src/views/WatchView.vue` — 接通 WS + daemon 控制
- `web/src/views/ConfigView.vue` — 持久化

**删除**：
- `web/src/views/DashboardView.vue` — 被 OverviewView 替代
- `web/src/views/SearchView.vue` — 被 ContextView 替代

---

## 🚦 启动指南

### 快速启动
```bash
# 方式 1：一键启动（如果脚本存在）
./start-dashboard.sh

# 方式 2：手动启动
# 终端 1 - 后端
npm run web:server

# 终端 2 - 前端
cd web && npm run dev
```

访问 **http://localhost:5173**

### 首次使用流程
1. **Overview 页** — 查看自动索引的仓库状态
2. **Context 页** — 输入查询（如 "how does the context engine work"），体验完整 ContextPack
3. **Graph 页** — 点击"Load Graph"，查看代码关系图谱
4. **Impact 页** — 输入符号名（如 "RagCodeEngine"），点击"Impact"查看影响分析
5. **Watch 页** — 点击"Start Watch"，实时监控文件变更
6. **Config 页** — 修改配置，点击"Save Configuration"持久化

---

## 🎯 后续优化方向（可选）

### 短期
- [ ] ContextView 代码片段增强（行号、折叠、跳转到编辑器）
- [ ] GraphView 增加搜索节点、高亮路径
- [ ] ImpactView 增加可视化（流程图/树图）
- [ ] OverviewView 增加索引历史趋势图

### 长期
- [ ] 多仓库并行管理（切换/对比）
- [ ] 用户认证（团队协作）
- [ ] 导出报告（PDF/Markdown）
- [ ] 性能监控（查询耗时/缓存命中率）
- [ ] 移动端适配

---

## 💡 设计理念

本次重构遵循以下原则：

1. **功能完整性** — 引擎能力 100% 暴露，不留"TODO"
2. **类型安全** — 前后端类型完全对齐，编译时防护
3. **开发者体验** — 深色工具风、高信息密度、快速导航
4. **可观测性** — 新鲜度/burstMode/调度器状态全部可视化
5. **扩展性** — 模块化设计，易于新增视图/分析功能

---

## 📝 总结

✅ **全部问题已修复**  
✅ **引擎能力完全暴露**  
✅ **前后端零类型错误**  
✅ **6 个专业视图就绪**  
✅ **开发者工具风设计系统**  
✅ **WebSocket 实时监控**  
✅ **配置持久化生效**  

从"不好用的原型"升级为**生产级代码上下文管理平台**。
