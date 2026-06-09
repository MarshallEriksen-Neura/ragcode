<template>
  <div class="rc-shell">
    <header class="rc-topbar">
      <div class="rc-brand">
        <span class="rc-brand-dot" :class="{ idle: !store.status }" />
        RagCode
        <span class="rc-faint" style="font-weight: 400">Context Engine</span>
      </div>
      <div class="rc-topbar-meta">
        <span v-if="store.status" :title="store.status.repoRoot">
          📁 {{ repoName }}
        </span>
        <span v-if="store.status">
          {{ store.status.fileCount }} files · {{ store.status.symbolCount }} symbols
        </span>
        <span v-if="store.status && store.status.staleFileCount > 0" class="rc-badge warning">
          {{ store.status.staleFileCount }} stale
        </span>
        <span v-if="wsConnected" class="rc-badge success">● live</span>
        <span v-else class="rc-badge neutral">○ offline</span>
      </div>
    </header>

    <nav class="rc-sidebar">
      <div class="rc-nav-group-label">Workspace</div>
      <div
        v-for="item in primaryNav"
        :key="item.path"
        class="rc-nav-item"
        :class="{ active: route.path === item.path }"
        @click="go(item.path)"
      >
        <span class="rc-nav-icon">{{ item.icon }}</span>
        {{ item.label }}
      </div>

      <div class="rc-nav-group-label">Analysis</div>
      <div
        v-for="item in analysisNav"
        :key="item.path"
        class="rc-nav-item"
        :class="{ active: route.path === item.path }"
        @click="go(item.path)"
      >
        <span class="rc-nav-icon">{{ item.icon }}</span>
        {{ item.label }}
      </div>

      <div class="rc-nav-group-label">System</div>
      <div
        v-for="item in systemNav"
        :key="item.path"
        class="rc-nav-item"
        :class="{ active: route.path === item.path }"
        @click="go(item.path)"
      >
        <span class="rc-nav-icon">{{ item.icon }}</span>
        {{ item.label }}
      </div>
    </nav>

    <main class="rc-main">
      <router-view />
    </main>

    <ToastDisplay />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useRepoStore } from './stores/repo'
import { useWatchStore } from './stores/watch'
import ToastDisplay from './components/ToastDisplay.vue'

const router = useRouter()
const route = useRoute()
const store = useRepoStore()
const watchStore = useWatchStore()

const wsConnected = computed(() => watchStore.connected)
const repoName = computed(() => {
  const root = store.status?.repoRoot ?? ''
  return root.split(/[/\\]/).filter(Boolean).pop() ?? root
})

const primaryNav = [
  { path: '/overview', label: 'Overview', icon: '▦' },
  { path: '/context', label: 'Context', icon: '◎' },
  { path: '/graph', label: 'Code Graph', icon: '⌗' },
]
const analysisNav = [
  { path: '/impact', label: 'Impact & Trace', icon: '⚡' },
  { path: '/watch', label: 'Live Watch', icon: '◉' },
]
const systemNav = [{ path: '/config', label: 'Config', icon: '⚙' }]

function go(path: string) {
  router.push(path)
}

onMounted(() => {
  store.refreshStatus()
  watchStore.connect()
})
</script>

<style scoped>
.rc-brand-dot.idle {
  background: var(--text-faint);
  box-shadow: none;
}
</style>
