import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { RagCodeEngine } from '../core/engine.js'
import { createGraphRuntimeFromEnv } from '../config/graph-runtime.js'
import { createSemanticRuntimeFromEnv } from '../config/semantic-runtime.js'
import type { ContextMode } from '../core/types.js'

const app = express()
const port = process.env.RAGCODE_WEB_PORT ? parseInt(process.env.RAGCODE_WEB_PORT) : 3000

app.use(cors())
app.use(express.json())

// 全局 engine 实例
let engine: RagCodeEngine | null = null

// 初始化 engine
async function initializeEngine(repoPath: string): Promise<void> {
  const graphRuntime = createGraphRuntimeFromEnv()
  const semanticRuntime = createSemanticRuntimeFromEnv()

  engine = new RagCodeEngine({
    graphStore: graphRuntime.graphStore,
    semanticStore: semanticRuntime.semanticStore,
    embeddingProvider: semanticRuntime.embeddingProvider,
  })

  // 索引仓库
  await engine.indexRepo(repoPath)
}

// ===== 配置管理 =====
app.get('/api/config', (req, res) => {
  res.json({
    graphStore: process.env.RAGCODE_GRAPH_STORE || 'memory',
    semanticStore: process.env.RAGCODE_SEMANTIC_STORE || 'memory',
    embeddingProvider: process.env.RAGCODE_EMBEDDING_PROVIDER || 'deterministic',
    sqlitePath: process.env.RAGCODE_SQLITE_PATH,
    lancedbUri: process.env.RAGCODE_LANCEDB_URI,
  })
})

app.post('/api/config', (req, res) => {
  // TODO: 持久化配置到 .ragcode/config.json
  res.json({ success: true })
})

// ===== 索引管理 =====
app.post('/api/index', async (req, res) => {
  const { repoPath } = req.body
  if (!repoPath) {
    return res.status(400).json({ error: 'repoPath required' })
  }

  try {
    await initializeEngine(repoPath)
    res.json({ success: true, message: 'Indexing completed' })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/index/stats', async (req, res) => {
  if (!engine) {
    return res.status(400).json({ error: 'Engine not initialized' })
  }

  try {
    // 传入 undefined 让 engine 自动解析当前 workspace
    const status = await engine.indexStatus(undefined)

    res.json({
      filesCount: status.fileCount,
      symbolsCount: status.symbolCount,
      chunksCount: status.chunkCount,
      edgesCount: status.edgeCount,
      storageSize: 0, // TODO: 从磁盘读取
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// ===== 检索调试 =====
app.post('/api/search', async (req, res) => {
  const { query, mode } = req.body as { query: string; mode: ContextMode }

  if (!engine) {
    return res.status(400).json({ error: 'Engine not initialized' })
  }

  try {
    const context = await engine.getContext({
      query,
      mode: mode || 'auto',
      budgetChars: 16000, // 约 4000 tokens
    })
    res.json(context)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// ===== 图谱查询 =====
app.get('/api/graph/nodes', async (req, res) => {
  if (!engine) {
    return res.status(400).json({ error: 'Engine not initialized' })
  }

  try {
    const nodes: any[] = []
    const edges: any[] = []

    // 获取符号列表
    const symbols = await engine.searchCode({ query: '', limit: 100 })

    // 构建节点
    for (const hit of symbols) {
      nodes.push({
        id: hit.chunk.id,
        label: hit.chunk.symbolName || 'unknown',
        type: 'symbol',
        kind: hit.chunk.kind,
        parent: hit.chunk.filePath,
      })
    }

    // TODO: 从 GraphStore 获取边关系
    res.json({ nodes, edges })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/graph/symbol/:name', async (req, res) => {
  const { name } = req.params
  if (!engine) {
    return res.status(400).json({ error: 'Engine not initialized' })
  }

  try {
    const result = await engine.findSymbol(undefined, name)
    res.json(result)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// ===== WebSocket 实时事件推送 =====
const server = app.listen(port, () => {
  console.log(`RagCode Dashboard running at http://localhost:${port}`)
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  console.log('WebSocket client connected')

  // TODO: 订阅 watch daemon 事件并推送
  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }))

  ws.on('close', () => {
    console.log('WebSocket client disconnected')
  })
})

// 优雅关闭
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
