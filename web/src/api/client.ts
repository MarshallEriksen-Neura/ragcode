import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

export interface Config {
  graphStore: string
  semanticStore: string
  embeddingProvider: string
  sqlitePath?: string
  lancedbUri?: string
}

export interface IndexStats {
  filesCount: number
  symbolsCount: number
  chunksCount: number
  edgesCount: number
  storageSize: number
}

export interface SearchRequest {
  query: string
  mode: 'auto' | 'debug' | 'feature' | 'refactor' | 'review' | 'explain'
}

export interface GraphNode {
  id: string
  label: string
  type: 'file' | 'symbol'
  kind?: string
  language?: string
  parent?: string
}

export interface GraphEdge {
  from: string
  to: string
  type: string
}

export const configApi = {
  getConfig: () => api.get<Config>('/config'),
  updateConfig: (config: Partial<Config>) => api.post('/config', config),
}

export const indexApi = {
  triggerIndex: (repoPath: string) => api.post('/index', { repoPath }),
  getStats: () => api.get<IndexStats>('/index/stats'),
}

export const searchApi = {
  search: (params: SearchRequest) => api.post('/search', params),
}

export const graphApi = {
  getNodes: () => api.get<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/graph/nodes'),
  getSymbol: (name: string) => api.get(`/graph/symbol/${name}`),
}

export default api
