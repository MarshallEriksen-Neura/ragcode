# RagCode 发布和安装策略总结

## 📋 概述

本文档总结了 RagCode 项目的发布和用户安装方案。

---

## 🎯 推荐的发布方式

### 1. **npm 包发布（主要方式）**

**优点**：
- 符合 Node.js 生态习惯
- 自动依赖管理
- 支持版本控制和语义化版本
- 可通过 `npx` 零安装试用

**用户安装**：
```bash
# 全局安装
npm install -g ragcode-context-engine

# 或使用 npx（无需安装）
npx ragcode-context-engine index .
```

**发布流程**：
```bash
# 1. 更新版本
npm version patch/minor/major

# 2. 构建
npm run build

# 3. 发布
npm publish
```

---

## 🚀 用户使用流程

### 快速开始（3步）

```bash
# 1. 安装
npm install -g ragcode-context-engine

# 2. 初始化配置（交互式向导）
ragcode init

# 3. 索引代码库
ragcode index .
```

### 配置方式

**方式 1：交互式向导（推荐新手）**
```bash
ragcode init
# 会提示选择：
# - Graph Store: SQLite 或 Memory
# - Semantic Store: LanceDB 或 Memory  
# - Embedding Provider: OpenAI 或 Deterministic
```

**方式 2：环境变量**
```bash
export RAGCODE_GRAPH_STORE=sqlite
export RAGCODE_SQLITE_PATH=.ragcode/graph.sqlite
export RAGCODE_SEMANTIC_STORE=lancedb
export RAGCODE_LANCEDB_URI=.ragcode/lancedb
export RAGCODE_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=your-key
```

**方式 3：配置文件**
创建 `.ragcode/config.json`：
```json
{
  "graphStore": "sqlite",
  "sqlitePath": ".ragcode/graph.sqlite",
  "semanticStore": "lancedb",
  "lancedbUri": ".ragcode/lancedb",
  "embeddingProvider": "openai"
}
```

---

## 🔌 MCP 集成（AI Agent）

### 一键配置（推荐）

```bash
# 自动配置 Claude Desktop
ragcode setup-mcp

# 重启 Claude Desktop 即可使用
```

### 手动配置

```bash
# 打印配置内容
ragcode setup-mcp --print

# 或指定自定义配置路径
ragcode setup-mcp --config ~/.config/custom-mcp.json
```

**可用的 MCP 工具**：
- `index_repo` - 索引代码库
- `search_code` - 混合搜索（关键词+语义+图）
- `get_context` - 构建 Agent 上下文包
- `find_symbol` - 定位符号定义
- `explain_file` - 文件概览
- `find_owner` - 追踪所有权链
- `impact_analysis` - 变更影响分析
- `related_tests` - 查找相关测试
- `trace_flow` - 追踪执行流程
- `review_diff` - 代码审查

---

## 🌐 Web 仪表盘

```bash
ragcode dashboard

# 功能：
# - 配置管理
# - 实时索引统计
# - 代码图可视化
# - 搜索调试器
# - 文件变更监控
```

---

## 📦 其他发布方式

### Docker 镜像

```dockerfile
# Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
RUN npm link
ENTRYPOINT ["ragcode"]
```

```bash
# 使用
docker run -v /path/to/code:/workspace ragcode/engine:latest index /workspace
```

### 独立可执行文件

使用 `pkg` 打包成单文件：
```bash
pkg package.json
# 生成：
# - ragcode-linux
# - ragcode-macos  
# - ragcode-win.exe
```

**优点**：无需 Node.js 环境

---

## 📚 文档结构

创建的文档：
- `docs/INSTALLATION.md` - 详细安装指南
- `docs/PUBLISHING.md` - 发布检查清单和流程
- `scripts/init-config.ts` - 交互式配置向导
- `scripts/setup-mcp.ts` - MCP 自动配置工具
- `.npmignore` - npm 发布过滤配置

---

## ✅ 发布前检查清单

### 代码质量
- [ ] 所有测试通过：`bun run test`
- [ ] 类型检查通过：`bun run check`
- [ ] 构建成功：`bun run build`

### package.json
- [ ] `private: false` 已设置
- [ ] 版本号已更新
- [ ] `keywords` 已填写
- [ ] `repository` URL 正确
- [ ] `license` 已设置

### 文档
- [ ] README.md 最新
- [ ] INSTALLATION.md 已审查
- [ ] CLI 帮助文本准确

### 测试安装
```bash
# 本地测试
npm pack
npm install -g ./ragcode-context-engine-*.tgz
ragcode --version
ragcode init
```

---

## 🎬 发布步骤

```bash
# 1. 版本更新
npm version patch  # 0.1.0 -> 0.1.1

# 2. 构建
npm run build

# 3. 发布
npm publish

# 4. 验证
npm view ragcode-context-engine
npm install -g ragcode-context-engine@latest
ragcode --version
```

---

## 💡 用户体验亮点

1. **零配置启动**：`ragcode init` 交互式向导
2. **一键 MCP 集成**：`ragcode setup-mcp` 自动配置
3. **离线模式**：Deterministic embeddings（无需 API key）
4. **Web 仪表盘**：可视化管理界面
5. **npx 支持**：无需安装即可试用

---

## 📊 部署场景

| 场景 | 推荐方式 | 命令 |
|------|---------|------|
| 个人开发 | npm 全局安装 | `npm install -g ragcode-context-engine` |
| 项目依赖 | 本地安装 | `npm install --save-dev ragcode-context-engine` |
| AI Agent | MCP 集成 | `ragcode setup-mcp` |
| 企业内网 | Docker 镜像 | `docker pull ragcode/engine:latest` |
| 离线环境 | 独立可执行文件 | 下载 `ragcode-*.exe` |

---

## 🔄 持续集成

可添加 GitHub Actions 自动发布：

```yaml
name: Publish to npm
on:
  release:
    types: [created]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 24
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 📞 支持渠道

发布后建议：
- 创建 GitHub Discussions 用于讨论
- 设置 issue 模板
- 添加 CONTRIBUTING.md
- 建立 Discord/Slack 社区

---

## 总结

RagCode 采用 **npm 包为主、多方式补充** 的发布策略：

✅ **主流用户**：npm 全局安装 + `ragcode init` 向导  
✅ **AI Agent**：`ragcode setup-mcp` 一键集成  
✅ **企业用户**：Docker 镜像 + 私有仓库  
✅ **特殊场景**：独立可执行文件

这种策略覆盖了从个人开发者到企业用户的各类场景，并通过交互式工具降低了配置门槛。
