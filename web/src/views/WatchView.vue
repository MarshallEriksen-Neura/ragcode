<template>
  <div class="rc-col">
    <h1 class="rc-page-title">Live Watch</h1>
    <p class="rc-page-sub">Real-time file system monitoring and indexing scheduler</p>

    <!-- Controls -->
    <div class="rc-panel">
      <div class="rc-panel-body">
        <div class="rc-row rc-wrap" style="gap: 12px; align-items: center">
          <span class="rc-badge" :class="watchStore.connected ? 'success' : 'neutral'">
            {{ watchStore.connected ? '● WebSocket connected' : '○ WebSocket offline' }}
          </span>
          <span v-if="watchStore.daemonRunning" class="rc-badge success">Daemon running</span>
          <span v-else class="rc-badge neutral">Daemon idle</span>
          <div class="rc-spacer" />
          <button v-if="!watchStore.daemonRunning" class="rc-btn primary" @click="handleStart" :disabled="starting">
            {{ starting ? 'Starting...' : 'Start Watch' }}
          </button>
          <button v-else class="rc-btn" @click="handleStop" :disabled="stopping">
            {{ stopping ? 'Stopping...' : 'Stop Watch' }}
          </button>
          <button class="rc-btn" @click="watchStore.clearEvents">Clear Events</button>
          <select v-model="eventFilter" class="rc-select" style="width: 120px">
            <option value="">All events</option>
            <option value="file-event">File events</option>
            <option value="watch-status">Status</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Daemon status -->
    <div v-if="status" class="rc-panel">
      <div class="rc-panel-header">Daemon Status</div>
      <div class="rc-panel-body rc-col" style="gap: 10px">
        <div class="rc-row rc-wrap" style="gap: 12px">
          <span class="rc-badge" :class="status.ready ? 'success' : 'warning'">
            {{ status.ready ? 'Ready' : 'Initializing' }}
          </span>
          <span class="rc-mono rc-faint" style="font-size: 11px">Buffered: {{ status.bufferedEvents }}</span>
        </div>

        <div class="rc-divider" />

        <div class="rc-col" style="gap: 6px">
          <div class="rc-muted" style="font-size: 11px">Scheduler:</div>
          <div class="rc-row rc-wrap" style="gap: 10px">
            <span v-if="status.scheduler.scheduled" class="rc-badge accent">Scheduled</span>
            <span v-if="status.scheduler.indexing" class="rc-badge info">Indexing</span>
            <span class="rc-mono rc-faint" style="font-size: 11px">Pending: {{ status.scheduler.pendingFiles }}</span>
            <span class="rc-mono rc-faint" style="font-size: 11px">Indexing: {{ status.scheduler.indexingFiles }}</span>
          </div>
          <div v-if="status.scheduler.lastIndexedAtMs" class="rc-mono rc-faint" style="font-size: 11px">
            Last indexed: {{ formatTime(status.scheduler.lastIndexedAtMs) }}
          </div>
          <div v-if="status.scheduler.lastError" class="rc-badge danger" style="align-self: flex-start">
            {{ status.scheduler.lastError }}
          </div>
        </div>
      </div>
    </div>

    <!-- Event stream -->
    <div class="rc-panel">
      <div class="rc-panel-header">Event Stream ({{ filteredEvents.length }})</div>
      <div class="rc-panel-body">
        <div class="rc-col" style="gap: 6px; max-height: 500px; overflow-y: auto">
          <div v-for="event in filteredEvents" :key="event.id" class="rc-row" style="gap: 10px; font-size: 12px">
            <span class="rc-mono rc-faint" style="width: 70px; flex-shrink: 0">{{ formatTime(event.timestamp) }}</span>
            <span class="rc-badge" :class="eventTypeBadge(event)" style="font-size: 10px; padding: 1px 6px">
              {{ event.event ?? event.type }}
            </span>
            <span v-if="event.path" class="rc-mono rc-muted" style="font-size: 11px">{{ shortPath(event.path, 60) }}</span>
          </div>
          <div v-if="filteredEvents.length === 0" class="rc-empty">No events yet</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWatchStore, type WatchEvent } from '../stores/watch'
import { watchApi } from '../api/client'
import { useToast } from '../composables/toast'
import { formatTime, shortPath } from '../utils/format'

const watchStore = useWatchStore()
const toast = useToast()
const starting = ref(false)
const stopping = ref(false)
const eventFilter = ref('')

const status = computed(() => watchStore.daemonStatus)

const filteredEvents = computed(() => {
  if (!eventFilter.value) return watchStore.events
  return watchStore.events.filter((e) => e.type === eventFilter.value)
})

function eventTypeBadge(event: WatchEvent): string {
  if (event.type === 'file-event') {
    if (event.event === 'add') return 'success'
    if (event.event === 'change') return 'info'
    if (event.event === 'unlink') return 'danger'
    return 'neutral'
  }
  if (event.type === 'watch-status') return 'accent'
  if (event.type === 'watch-stopped') return 'warning'
  return 'neutral'
}

async function handleStart() {
  starting.value = true
  try {
    await watchApi.start()
    toast.success('Watch daemon started')
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    starting.value = false
  }
}

async function handleStop() {
  stopping.value = true
  try {
    await watchApi.stop()
    toast.success('Watch daemon stopped')
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    stopping.value = false
  }
}
</script>
