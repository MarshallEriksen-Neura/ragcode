# RagCode Dashboard

RagCode 的 Web 管理界面，提供配置管理、索引监控、代码图谱可视化和检索调试功能。

## 功能特性

### 1. 配置管理
- 图形化配置 Graph Store（memory/sqlite）
- 配置 Semantic Store（memory/lancedb）
- 选择 Embedding Provider（deterministic/openai）
- 设置存储路径

### 2. 索引仪表盘
- 实时查看索引统计（文件数、符号数、代码块数、关系边数）
- 一键触发仓库索引
- 索引状态监控

### 3. 代码图谱可视化
- 交互式代码依赖关系图
- 符号和文件节点可视化
- 基于 ECharts 的力导向图布局

### 4. 检索调试
- 支持多种检索模式（auto/debug/feature/refactor/review/explain）
- 查看检索结果和相关性得分
- 代码片段高亮显示

### 5. 实时监控
- WebSocket 实时推送文件变更事件
- 文件监控事件流可视化
- 事件历史记录

## 快速开始

### 1. 启动后端 API Server

```bash
# 设置环境变量（可选）
export RAGCODE_GRAPH_STORE=sqlite
export RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite
export RAGCODE_SEMANTIC_STORE=lancedb
export RAGCODE_LANCEDB_URI=.ragcode/lancedb
export RAGCODE_EMBEDDING_PROVIDER=deterministic

# 启动后端服务（默认端口 3000）
npm run web:server
```

### 2. 启动前端开发服务器

```bash
# 打开新终端
cd web
npm run dev
```

### 3. 访问 Dashboard

打开浏览器访问：http://localhost:5173

## 技术栈

- Vue 3 + TypeScript + Vite
- Naive UI + ECharts
- Axios + Pinia + Vue Router

## API 端点

- `GET /api/config` - 获取配置
- `POST /api/index` - 触发索引
- `GET /api/index/stats` - 索引统计
- `POST /api/search` - 执行检索
- `GET /api/graph/nodes` - 图谱数据
- `WebSocket ws://localhost:3000/ws` - 实时事件

## License

与 RagCode 主项目相同。
