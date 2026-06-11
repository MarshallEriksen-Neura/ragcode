import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { WebSocketServer, type WebSocket } from 'ws'
import { RagCodeEngine } from '../core/engine.js'
import { createRuntimeComponentsForRepo, loadRuntimeConfig, readRuntimeConfigFile, redactRuntimeConfig, writeRuntimeConfigFile, type RuntimeConfigFile } from '../config/runtime-config.js'
import { FileWatchDaemon, type WatchDaemonStatus } from '../watch/watch-daemon.js'
import type { WatchEventJournalEntry } from '../watch/event-journal.js'
import type { ContextMode, SymbolNode, VerifiedSubgraphMode } from '../core/types.js'

const app = express()
const port = process.env.RAGCODE_WEB_PORT ? parseInt(process.env.RAGCODE_WEB_PORT) : 3000
const defaultRepo = path.resolve(process.env.RAGCODE_REPO_ROOT ?? process.cwd())
const configPath = path.join(defaultRepo, '.ragcode', 'config.json')

app.use(cors())
app.use(express.json({ limit: '4mb' }))

// ===== Shared engine + watch daemon =====
let engine: RagCodeEngine | null = null
let activeRepo: string | null = null
let daemon: FileWatchDaemon | null = null
let lastDaemonStatus: WatchDaemonStatus | null = null
const sockets = new Set<WebSocket>()

function broadcast(payload: unknown): void {
  const message = JSON.stringify(payload)
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(message)
  }
}

function buildEngine(repoPath = activeRepo ?? defaultRepo): RagCodeEngine {
  const runtime = createRuntimeComponentsForRepo({ cwd: repoPath, overrides: { repoRoot: repoPath } })
  return new RagCodeEngine({
    cwd: repoPath,
    graphStore: runtime.graphStore,
    semanticStore: runtime.semanticStore,
    embeddingProvider: runtime.embeddingProvider,
  })
}

async function ensureEngine(repoPath?: string): Promise<RagCodeEngine> {
  const target = repoPath ? path.resolve(repoPath) : (activeRepo ?? defaultRepo)
  if (engine && activeRepo === target) return engine
  engine = buildEngine()
  await engine.indexRepo(target)
  activeRepo = target
  return engine
}

function requireEngine(res: express.Response): RagCodeEngine | null {
  if (!engine) {
    res.status(409).json({ error: 'Engine not initialized. Index a repository first via POST /api/index.' })
    return null
  }
  return engine
}

function fail(res: express.Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  res.status(500).json({ error: message })
}

// ===== Config (persisted to .ragcode/config.json) =====
app.get('/api/config', (_req, res) => {
  const repoRoot = activeRepo ?? defaultRepo
  const runtime = redactRuntimeConfig(loadRuntimeConfig({ cwd: repoRoot, overrides: { repoRoot } }))
  res.json(runtime)
})

app.post('/api/config', (req, res) => {
  try {
    const repoRoot = activeRepo ?? defaultRepo
    const body = req.body as Partial<RuntimeConfigFile>
    const merged = { ...readRuntimeConfigFile(path.join(repoRoot, '.ragcode', 'config.json')), ...body }
    const writtenPath = writeRuntimeConfigFile(repoRoot, merged)
    res.json({ success: true, configPath: writtenPath, note: 'Restart the server or re-index the repository for store/provider changes to take effect.' })
  } catch (error) {
    fail(res, error)
  }
})

// ===== Index management =====
app.post('/api/index', async (req, res) => {
  const repoPath = (req.body?.repoPath as string | undefined) ?? defaultRepo
  try {
    const resolvedRepo = path.resolve(repoPath)
    const eng = buildEngine(resolvedRepo)
    await eng.indexRepo(resolvedRepo)
    engine = eng
    activeRepo = resolvedRepo
    const status = await eng.indexStatus(undefined)
    res.json({ success: true, repoRoot: activeRepo, status })
  } catch (error) {
    fail(res, error)
  }
})

app.post('/api/refresh', async (_req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  try {
    await eng.refreshIndex(undefined)
    res.json({ success: true, status: await eng.indexStatus(undefined) })
  } catch (error) {
    fail(res, error)
  }
})

app.get('/api/status', async (_req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  try {
    const status = await eng.indexStatus(undefined)
    res.json(status)
  } catch (error) {
    fail(res, error)
  }
})

app.get('/api/languages', async (_req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  try {
    const { symbols } = await eng.graphSnapshot(undefined)
    const byLanguage = new Map<string, number>()
    for (const sym of symbols) {
      byLanguage.set(sym.language, (byLanguage.get(sym.language) ?? 0) + 1)
    }
    res.json({ languages: [...byLanguage.entries()].map(([language, count]) => ({ language, count })) })
  } catch (error) {
    fail(res, error)
  }
})

// ===== Context retrieval (full ContextPack) =====
app.post('/api/context', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { query, mode, budgetChars } = req.body as { query: string; mode?: ContextMode; budgetChars?: number }
  if (!query?.trim()) return res.status(400).json({ error: 'query required' })
  try {
    const pack = await eng.getContext({
      query,
      mode: mode ?? 'auto',
      budgetChars: budgetChars ?? 16000,
    })
    res.json(pack)
  } catch (error) {
    fail(res, error)
  }
})

// ===== Raw search hits =====
app.post('/api/search', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { query, mode, limit } = req.body as { query: string; mode?: ContextMode; limit?: number }
  try {
    const hits = await eng.searchCode({ query: query ?? '', mode, limit: limit ?? 30 })
    res.json({ hits })
  } catch (error) {
    fail(res, error)
  }
})

// ===== Code graph (real nodes + edges) =====
app.get('/api/graph', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const language = req.query.language as string | undefined
  const kind = req.query.kind as string | undefined
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 400
  try {
    const { symbols, edges } = await eng.graphSnapshot(undefined)
    let filtered = symbols
    if (language) filtered = filtered.filter((s) => s.language === language)
    if (kind) filtered = filtered.filter((s) => s.kind === kind)
    filtered = filtered.slice(0, limit)

    const nodeIds = new Set(filtered.map((s) => s.id))
    const nodes = filtered.map((s) => toGraphNode(s))
    const scopedEdges = edges.filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
    res.json({ nodes, edges: scopedEdges, total: symbols.length, shown: nodes.length, totalEdges: edges.length })
  } catch (error) {
    fail(res, error)
  }
})

function toGraphNode(symbol: SymbolNode) {
  return {
    id: symbol.id,
    label: symbol.name,
    kind: symbol.kind,
    language: symbol.language,
    filePath: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: symbol.exported ?? false,
    signature: symbol.signature,
  }
}

app.get('/api/symbol/:name', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  try {
    res.json({ symbols: await eng.findSymbol(undefined, req.params.name) })
  } catch (error) {
    fail(res, error)
  }
})

app.get('/api/file', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const filePath = req.query.path as string | undefined
  if (!filePath) return res.status(400).json({ error: 'path required' })
  try {
    res.json(await eng.explainFile(undefined, filePath))
  } catch (error) {
    fail(res, error)
  }
})

// ===== Impact / trace / tests / reuse / subgraph =====
app.post('/api/impact', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { target } = req.body as { target: string }
  if (!target?.trim()) return res.status(400).json({ error: 'target required' })
  try {
    res.json(await eng.impactAnalysis(undefined, target))
  } catch (error) {
    fail(res, error)
  }
})

app.post('/api/trace', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { entry, maxSteps } = req.body as { entry: string; maxSteps?: number }
  if (!entry?.trim()) return res.status(400).json({ error: 'entry required' })
  try {
    res.json(await eng.traceFlow(undefined, entry, maxSteps))
  } catch (error) {
    fail(res, error)
  }
})

app.post('/api/related-tests', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { target } = req.body as { target: string }
  if (!target?.trim()) return res.status(400).json({ error: 'target required' })
  try {
    res.json(await eng.relatedTests(undefined, target))
  } catch (error) {
    fail(res, error)
  }
})

app.post('/api/reuse', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { query, limit } = req.body as { query: string; limit?: number }
  if (!query?.trim()) return res.status(400).json({ error: 'query required' })
  try {
    res.json(await eng.findReuseCandidates({ query, limit: limit ?? 8 }))
  } catch (error) {
    fail(res, error)
  }
})

app.post('/api/subgraph', async (req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  const { query, mode, maxHops, budgetChars } = req.body as {
    query: string
    mode?: VerifiedSubgraphMode
    maxHops?: number
    budgetChars?: number
  }
  if (!query?.trim()) return res.status(400).json({ error: 'query required' })
  try {
    res.json(await eng.verifiedSubgraph({ query, mode: mode ?? 'impact', maxHops, budgetChars }))
  } catch (error) {
    fail(res, error)
  }
})

// ===== Watch daemon control =====
app.get('/api/watch/status', async (_req, res) => {
  if (!daemon) return res.json({ running: false, status: null })
  res.json({ running: true, status: await daemon.status() })
})

app.post('/api/watch/start', async (_req, res) => {
  const eng = requireEngine(res)
  if (!eng) return
  if (daemon) return res.json({ success: true, alreadyRunning: true })
  try {
    daemon = new FileWatchDaemon(eng, activeRepo ?? defaultRepo, {
      indexOnStart: false,
      onEvent: (event: WatchEventJournalEntry) => {
        broadcast({ type: 'file-event', event: event.event, path: event.filePath, timestamp: event.observedAtMs })
      },
      onStatus: (status: WatchDaemonStatus) => {
        lastDaemonStatus = status
        broadcast({ type: 'watch-status', status, timestamp: Date.now() })
      },
    })
    await daemon.start()
    res.json({ success: true, status: await daemon.status() })
  } catch (error) {
    daemon = null
    fail(res, error)
  }
})

app.post('/api/watch/stop', async (_req, res) => {
  if (!daemon) return res.json({ success: true, alreadyStopped: true })
  try {
    await daemon.stop()
    daemon = null
    broadcast({ type: 'watch-stopped', timestamp: Date.now() })
    res.json({ success: true })
  } catch (error) {
    fail(res, error)
  }
})

// ===== Server bootstrap =====
const server = app.listen(port, () => {
  console.log(`RagCode Dashboard API running at http://localhost:${port}`)
  // Auto-index the default repo so the dashboard has data on first load.
  ensureEngine().catch((error) => {
    console.error('Initial indexing failed:', error instanceof Error ? error.message : error)
  })
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  sockets.add(ws)
  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now(), watchRunning: daemon !== null }))
  if (lastDaemonStatus) {
    ws.send(JSON.stringify({ type: 'watch-status', status: lastDaemonStatus, timestamp: Date.now() }))
  }
  ws.on('close', () => sockets.delete(ws))
  ws.on('error', () => sockets.delete(ws))
})

async function shutdown(): Promise<void> {
  await daemon?.stop().catch(() => undefined)
  engine?.close()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
