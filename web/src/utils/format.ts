export function formatTime(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatDateTime(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function relativeTime(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

export function confidenceClass(c: string): string {
  return `rc-conf-${c}`
}

export function riskClass(r: string): string {
  return `rc-risk-${r}`
}

export function scoreBadge(score: number): 'success' | 'warning' | 'neutral' {
  if (score >= 0.7) return 'success'
  if (score >= 0.4) return 'warning'
  return 'neutral'
}

export function shortPath(filePath: string, max = 48): string {
  if (filePath.length <= max) return filePath
  const parts = filePath.split('/')
  if (parts.length <= 2) return '…' + filePath.slice(-max)
  return `${parts[0]}/…/${parts[parts.length - 1]}`
}

const EDGE_COLORS: Record<string, string> = {
  calls: '#2f81f7',
  imports: '#a371f7',
  exports: '#d29922',
  contains: '#545d68',
  references: '#3fb950',
  tested_by: '#56d4dd',
  routes_to: '#f85149',
  calls_api: '#db61a2',
  handles_event: '#e3b341',
  uses_middleware: '#8957e5',
  reads_from: '#39c5cf',
  writes_to: '#bc8cff',
  related: '#768390',
}

export function edgeColor(kind: string): string {
  return EDGE_COLORS[kind] ?? '#768390'
}

const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f1e05a',
  python: '#3572a5',
  rust: '#dea584',
  go: '#00add8',
  java: '#b07219',
  markdown: '#083fa1',
  json: '#cbcb41',
  unknown: '#768390',
}

export function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? '#768390'
}
