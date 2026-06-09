<template>
  <div class="rc-col">
    <div>
      <h1 class="rc-page-title">Index Overview</h1>
      <p class="rc-page-sub">Repository indexing status and freshness metrics</p>
    </div>

    <div class="rc-panel" v-if="!status && !loading">
      <div class="rc-panel-body">
        <div class="rc-empty">
          <div style="font-size: 48px; margin-bottom: 12px">📦</div>
          <div>No repository indexed yet</div>
          <div class="rc-muted" style="margin-top: 8px">Index a repository to get started</div>
          <div class="rc-row" style="margin-top: 16px; justify-content: center">
            <input v-model="repoPath" class="rc-input" placeholder="Repository path" style="width: 350px" />
            <button class="rc-btn primary" @click="handleIndex" :disabled="indexing">
              {{ indexing ? 'Indexing...' : 'Index Repository' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <template v-if="status">
      <!-- Stats grid -->
      <div class="rc-stat-grid">
        <div class="rc-stat">
          <div class="rc-stat-value">{{ status.fileCount }}</div>
          <div class="rc-stat-label">Files</div>
        </div>
        <div class="rc-stat">
          <div class="rc-stat-value">{{ status.symbolCount }}</div>
          <div class="rc-stat-label">Symbols</div>
        </div>
        <div class="rc-stat">
          <div class="rc-stat-value">{{ status.chunkCount }}</div>
          <div class="rc-stat-label">Chunks</div>
        </div>
        <div class="rc-stat">
          <div class="rc-stat-value">{{ status.edgeCount }}</div>
          <div class="rc-stat-label">Edges</div>
        </div>
      </div>

      <!-- Freshness panel -->
      <div class="rc-panel">
        <div class="rc-panel-header">Freshness</div>
        <div class="rc-panel-body">
          <div class="rc-row rc-wrap" style="gap: 16px">
            <div>
              <span class="rc-badge success">{{ status.freshFileCount }} fresh</span>
            </div>
            <div v-if="status.staleFileCount > 0">
              <span class="rc-badge warning">{{ status.staleFileCount }} stale</span>
            </div>
            <div v-if="status.pendingFileCount > 0">
              <span class="rc-badge info">{{ status.pendingFileCount }} pending</span>
            </div>
            <div v-if="status.indexingFileCount > 0">
              <span class="rc-badge accent">{{ status.indexingFileCount }} indexing</span>
            </div>
            <div v-if="status.skippedFileCount > 0">
              <span class="rc-badge neutral">{{ status.skippedFileCount }} skipped</span>
            </div>
            <div v-if="status.burstMode">
              <span class="rc-badge danger">⚡ Burst mode</span>
            </div>
          </div>

          <div class="rc-muted rc-mono" style="margin-top: 10px; font-size: 11px">
            Last indexed: {{ formatDateTime(status.indexedAtMs) }}
            <span v-if="status.freshness.indexGeneration > 1">
              · Gen {{ status.freshness.indexGeneration }}
            </span>
          </div>

          <div class="rc-row" style="margin-top: 14px; gap: 8px">
            <button class="rc-btn" @click="store.refreshStatus" :disabled="loading">Refresh</button>
            <button class="rc-btn" @click="handleReindex" :disabled="indexing">
              {{ indexing ? 'Indexing...' : 'Re-index' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Language distribution -->
      <div class="rc-panel" v-if="languages.length > 0">
        <div class="rc-panel-header">Language Distribution</div>
        <div class="rc-panel-body">
          <div class="rc-row rc-wrap" style="gap: 12px">
            <div v-for="lang in languages" :key="lang.language" class="rc-row" style="gap: 6px; align-items: center">
              <span
                class="rc-badge neutral"
                :style="{ borderColor: langColor(lang.language), color: langColor(lang.language) }"
              >
                {{ lang.language }}
              </span>
              <span class="rc-mono rc-muted" style="font-size: 11px">{{ lang.count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Skipped files -->
      <div class="rc-panel" v-if="status.freshness.skippedFiles.length > 0">
        <div class="rc-panel-header">Skipped Files</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 6px; max-height: 200px; overflow-y: auto">
            <div
              v-for="(skip, idx) in status.freshness.skippedFiles.slice(0, 50)"
              :key="idx"
              class="rc-row"
              style="font-size: 11px; gap: 8px"
            >
              <code class="rc-muted rc-mono" style="flex: 1">{{ skip.filePath }}</code>
              <span class="rc-faint">{{ skip.reason }}</span>
            </div>
          </div>
          <div v-if="status.freshness.skippedFiles.length > 50" class="rc-muted" style="margin-top: 8px; font-size: 11px">
            … and {{ status.freshness.skippedFiles.length - 50 }} more
          </div>
        </div>
      </div>

      <!-- Stale files (if any) -->
      <div class="rc-panel" v-if="status.freshness.staleFiles.length > 0">
        <div class="rc-panel-header">Stale Files</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 4px; max-height: 160px; overflow-y: auto">
            <code
              v-for="(file, idx) in status.freshness.staleFiles.slice(0, 40)"
              :key="idx"
              class="rc-muted rc-mono"
              style="font-size: 11px"
            >
              {{ file }}
            </code>
          </div>
          <div v-if="status.freshness.staleFiles.length > 40" class="rc-muted" style="margin-top: 8px; font-size: 11px">
            … and {{ status.freshness.staleFiles.length - 40 }} more
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRepoStore } from '../stores/repo'
import { indexApi } from '../api/client'
import { useToast } from '../composables/toast'
import { formatDateTime, langColor } from '../utils/format'

const store = useRepoStore()
const toast = useToast()
const repoPath = ref(process.cwd?.() ?? '')
const indexing = ref(false)
const languages = ref<Array<{ language: string; count: number }>>([])

const status = computed(() => store.status)
const loading = computed(() => store.loading)

async function handleIndex() {
  if (!repoPath.value.trim()) {
    toast.warning('Please enter a repository path')
    return
  }
  indexing.value = true
  try {
    await indexApi.trigger(repoPath.value)
    await store.refreshStatus()
    await loadLanguages()
    toast.success('Repository indexed')
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    indexing.value = false
  }
}

async function handleReindex() {
  indexing.value = true
  try {
    await indexApi.refresh()
    await store.refreshStatus()
    await loadLanguages()
    toast.success('Index refreshed')
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    indexing.value = false
  }
}

async function loadLanguages() {
  try {
    const { data } = await indexApi.languages()
    languages.value = data.languages.sort((a, b) => b.count - a.count)
  } catch {
    languages.value = []
  }
}

onMounted(() => {
  if (status.value) loadLanguages()
})
</script>
