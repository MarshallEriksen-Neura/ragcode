<template>
  <n-space vertical :size="24">
    <n-card title="文件监控">
      <n-space>
        <n-tag :type="connected ? 'success' : 'error'">
          {{ connected ? '● 已连接' : '○ 未连接' }}
        </n-tag>
        <n-button @click="handleConnect">
          {{ connected ? '断开' : '连接' }}
        </n-button>
        <n-button @click="handleClear">清空日志</n-button>
      </n-space>
    </n-card>

    <n-card title="实时事件流">
      <n-scrollbar style="max-height: 600px">
        <n-timeline>
          <n-timeline-item
            v-for="event in events"
            :key="event.id"
            :type="getEventType(event.type)"
            :time="formatTime(event.timestamp)"
          >
            <strong>{{ event.type }}</strong>
            <n-text v-if="event.path" depth="3">: {{ event.path }}</n-text>
          </n-timeline-item>
        </n-timeline>

        <n-empty v-if="events.length === 0" description="暂无事件" />
      </n-scrollbar>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { useMessage } from 'naive-ui'

const message = useMessage()
const connected = ref(false)
const events = ref<any[]>([])

let ws: WebSocket | null = null
let eventIdCounter = 0

const getEventType = (type: string) => {
  const typeMap: Record<string, any> = {
    connected: 'success',
    change: 'info',
    add: 'success',
    unlink: 'error',
  }
  return typeMap[type] || 'default'
}

const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString('zh-CN')
}

const handleConnect = () => {
  if (connected.value) {
    ws?.close()
    connected.value = false
    message.info('已断开连接')
  } else {
    try {
      ws = new WebSocket('ws://localhost:3000/ws')

      ws.onopen = () => {
        connected.value = true
        message.success('WebSocket 已连接')
      }

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        events.value.unshift({
          id: eventIdCounter++,
          ...data,
        })

        // 保留最近 100 条
        if (events.value.length > 100) {
          events.value = events.value.slice(0, 100)
        }
      }

      ws.onerror = () => {
        message.error('WebSocket 连接失败')
        connected.value = false
      }

      ws.onclose = () => {
        connected.value = false
        message.info('WebSocket 已断开')
      }
    } catch (error: any) {
      message.error('连接失败: ' + error.message)
    }
  }
}

const handleClear = () => {
  events.value = []
  message.success('已清空日志')
}

onUnmounted(() => {
  ws?.close()
})
</script>
