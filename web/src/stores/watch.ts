import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WatchDaemonStatus } from '../api/client'

export interface WatchEvent {
  id: number
  type: string
  event?: string
  path?: string
  timestamp: number
}

export const useWatchStore = defineStore('watch', () => {
  const connected = ref(false)
  const daemonRunning = ref(false)
  const events = ref<WatchEvent[]>([])
  const daemonStatus = ref<WatchDaemonStatus | null>(null)

  let ws: WebSocket | null = null
  let counter = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let manualClose = false

  function wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/ws`
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    manualClose = false
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connected.value = true
    }
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        handleMessage(data)
      } catch {
        /* ignore malformed */
      }
    }
    ws.onerror = () => {
      connected.value = false
    }
    ws.onclose = () => {
      connected.value = false
      ws = null
      if (!manualClose) scheduleReconnect()
    }
  }

  function handleMessage(data: any) {
    switch (data.type) {
      case 'connected':
        daemonRunning.value = Boolean(data.watchRunning)
        break
      case 'watch-status':
        daemonStatus.value = data.status
        daemonRunning.value = data.status?.running ?? false
        break
      case 'watch-stopped':
        daemonRunning.value = false
        daemonStatus.value = null
        pushEvent({ type: 'watch-stopped', timestamp: data.timestamp })
        break
      case 'file-event':
        pushEvent({
          type: 'file-event',
          event: data.event,
          path: data.path,
          timestamp: data.timestamp,
        })
        break
      default:
        break
    }
  }

  function pushEvent(e: Omit<WatchEvent, 'id'>) {
    events.value.unshift({ id: counter++, ...e })
    if (events.value.length > 200) events.value = events.value.slice(0, 200)
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, 3000)
  }

  function clearEvents() {
    events.value = []
  }

  function disconnect() {
    manualClose = true
    ws?.close()
    ws = null
    connected.value = false
  }

  return { connected, daemonRunning, events, daemonStatus, connect, disconnect, clearEvents }
})
