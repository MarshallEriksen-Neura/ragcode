<template>
  <div class="rc-col">
    <h1 class="rc-page-title">Configuration</h1>
    <p class="rc-page-sub">Storage engines, embedding providers, and runtime settings</p>

    <div class="rc-panel">
      <div class="rc-panel-header">Current Configuration</div>
      <div class="rc-panel-body rc-col" style="gap: 14px">
        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">Graph Store</label>
          <select v-model="form.graphStore" class="rc-select" style="width: 200px">
            <option value="memory">Memory (dev)</option>
            <option value="sqlite">SQLite (persistent)</option>
          </select>
          <span class="rc-faint" style="padding-top: 7px; font-size: 11px">Code structure & edges</span>
        </div>

        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">Semantic Store</label>
          <select v-model="form.semanticStore" class="rc-select" style="width: 200px">
            <option value="memory">Memory (dev)</option>
            <option value="lancedb">LanceDB (persistent)</option>
          </select>
          <span class="rc-faint" style="padding-top: 7px; font-size: 11px">Vector embeddings</span>
        </div>

        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">Embedding Provider</label>
          <select v-model="form.embeddingProvider" class="rc-select" style="width: 200px">
            <option value="deterministic">Deterministic (offline)</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
          <span class="rc-faint" style="padding-top: 7px; font-size: 11px">Text → vectors</span>
        </div>

        <div class="rc-divider" />

        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">SQLite Path</label>
          <input v-model="form.sqlitePath" class="rc-input" placeholder=".ragcode/graph.sqlite" style="flex: 1" />
        </div>

        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">LanceDB URI</label>
          <input v-model="form.lancedbUri" class="rc-input" placeholder=".ragcode/lancedb" style="flex: 1" />
        </div>

        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">Embedding Base URL</label>
          <input v-model="form.embeddingBaseUrl" class="rc-input" placeholder="https://api.openai.com/v1" style="flex: 1" />
        </div>

        <div class="rc-row" style="gap: 10px; align-items: flex-start">
          <label style="width: 160px; flex-shrink: 0; padding-top: 7px; font-size: 12px">Embedding Model</label>
          <input v-model="form.embeddingModel" class="rc-input" placeholder="text-embedding-3-small" style="flex: 1" />
        </div>

        <div class="rc-divider" />

        <div class="rc-row" style="gap: 10px">
          <button class="rc-btn primary" @click="handleSave" :disabled="saving">
            {{ saving ? 'Saving...' : 'Save Configuration' }}
          </button>
          <button class="rc-btn" @click="handleReset" :disabled="loading">Reset</button>
        </div>

        <div v-if="configPath" class="rc-muted rc-mono" style="font-size: 10px; margin-top: 4px">
          Config file: {{ configPath }}
        </div>
      </div>
    </div>

    <div class="rc-panel">
      <div class="rc-panel-header">Current Repository</div>
      <div class="rc-panel-body">
        <code v-if="repoRoot" class="rc-inline-code">{{ repoRoot }}</code>
        <span v-else class="rc-muted">No repository indexed</span>
      </div>
    </div>

    <div class="rc-panel">
      <div class="rc-panel-header">Notes</div>
      <div class="rc-panel-body rc-col" style="gap: 8px; font-size: 12px">
        <div class="rc-muted">
          • <strong>Memory</strong> stores are ephemeral and reset on server restart. Use for development/testing.
        </div>
        <div class="rc-muted">
          • <strong>SQLite / LanceDB</strong> persist to disk. Use for production or when you need to preserve the index across restarts.
        </div>
        <div class="rc-muted">
          • <strong>Deterministic</strong> embedding uses a simple hash function (no external API). Fast but low-quality semantic search.
        </div>
        <div class="rc-muted">
          • <strong>OpenAI-compatible</strong> requires an API key (set <code class="rc-inline-code">RAGCODE_EMBEDDING_API_KEY</code> env var).
        </div>
        <div class="rc-badge warning" style="margin-top: 6px; align-self: flex-start">
          ⚠ Restart the server after changing store or provider for changes to take effect.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { configApi, type Config } from '../api/client'
import { useToast } from '../composables/toast'

const toast = useToast()
const loading = ref(false)
const saving = ref(false)
const configPath = ref<string | undefined>(undefined)
const repoRoot = ref<string | undefined>(undefined)

const form = reactive<Partial<Config>>({
  graphStore: 'memory',
  semanticStore: 'memory',
  embeddingProvider: 'deterministic',
  sqlitePath: '',
  lancedbUri: '',
  embeddingBaseUrl: '',
  embeddingModel: '',
})

async function loadConfig() {
  loading.value = true
  try {
    const { data } = await configApi.get()
    Object.assign(form, data)
    configPath.value = data.configPath
    repoRoot.value = data.repoRoot
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  saving.value = true
  try {
    const { data } = await configApi.update(form)
    toast.success('Configuration saved')
    if (data.configPath) configPath.value = data.configPath
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    saving.value = false
  }
}

function handleReset() {
  loadConfig()
}

onMounted(() => {
  loadConfig()
})
</script>
