<template>
  <div class="rc-col">
    <h1 class="rc-page-title">Context Retrieval</h1>
    <p class="rc-page-sub">Debug and inspect context generation with full breakdown</p>

    <!-- Query input -->
    <div class="rc-panel">
      <div class="rc-panel-body">
        <div class="rc-col" style="gap: 12px">
          <textarea
            v-model="query"
            class="rc-textarea"
            placeholder="Enter your context query..."
            rows="3"
            @keydown.ctrl.enter="handleSearch"
          />
          <div class="rc-row">
            <select v-model="mode" class="rc-select" style="width: 180px">
              <option value="auto">Auto (auto)</option>
              <option value="debug">Debug</option>
              <option value="feature">Feature</option>
              <option value="refactor">Refactor</option>
              <option value="review">Review</option>
              <option value="explain">Explain</option>
            </select>
            <input v-model.number="budgetChars" type="number" class="rc-input" placeholder="Budget (chars)" style="width: 140px" />
            <button class="rc-btn primary" @click="handleSearch" :disabled="searching">
              {{ searching ? 'Searching...' : 'Get Context' }}
            </button>
            <div class="rc-spacer" />
            <span v-if="result" class="rc-mono rc-muted" style="font-size: 11px">
              {{ result.usedChars }} / {{ result.budgetChars }} chars
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Results -->
    <template v-if="result">
      <!-- Header badges -->
      <div class="rc-row rc-wrap" style="gap: 10px">
        <span class="rc-badge" :class="result.answerable ? 'success' : 'warning'">
          {{ result.answerable ? '✓ Answerable' : '! Partial' }}
        </span>
        <span class="rc-badge" :class="confidenceClass(result.confidence)">
          Confidence: {{ result.confidence }}
        </span>
        <span class="rc-badge accent">Mode: {{ result.mode }}</span>
        <span class="rc-badge neutral">{{ result.snippets.length }} snippets</span>
      </div>

      <!-- Brief -->
      <div class="rc-panel">
        <div class="rc-panel-header">Brief</div>
        <div class="rc-panel-body">{{ result.brief }}</div>
      </div>

      <!-- Owner chain -->
      <div class="rc-panel" v-if="result.ownerChain.length > 0">
        <div class="rc-panel-header">Owner Chain ({{ result.ownerChain.length }})</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 10px">
            <div v-for="(owner, idx) in result.ownerChain" :key="idx" class="rc-row" style="gap: 12px; align-items: flex-start">
              <span class="rc-badge info" style="flex-shrink: 0">{{ owner.role }}</span>
              <div class="rc-col" style="gap: 4px; flex: 1">
                <code class="rc-inline-code">{{ owner.filePath }}</code>
                <div class="rc-muted" style="font-size: 12px">{{ owner.reason }}</div>
                <div v-if="owner.symbols.length > 0" class="rc-row rc-wrap" style="gap: 6px; margin-top: 4px">
                  <span
                    v-for="(sym, si) in owner.symbols"
                    :key="si"
                    class="rc-mono rc-muted"
                    style="font-size: 11px"
                    :title="`${sym.kind} at line ${sym.startLine}`"
                  >
                    {{ sym.name }}
                  </span>
                </div>
              </div>
              <span class="rc-mono rc-faint" style="font-size: 11px">{{ owner.score.toFixed(2) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Topology -->
      <div class="rc-panel" v-if="result.topology.length > 0">
        <div class="rc-panel-header">Topology ({{ result.topology.length }} edges)</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 8px; max-height: 300px; overflow-y: auto">
            <div v-for="(edge, idx) in result.topology" :key="idx" class="rc-row" style="gap: 10px; font-size: 12px">
              <span class="rc-mono rc-muted" style="flex-shrink: 0">{{ shortPath(edge.from, 28) }}</span>
              <span class="rc-badge neutral" style="font-size: 10px; padding: 1px 6px" :style="{ borderColor: edgeColor(edge.edge) }">
                {{ edge.edge }}
              </span>
              <span class="rc-mono rc-muted" style="flex-shrink: 0">{{ shortPath(edge.to, 28) }}</span>
              <span class="rc-spacer" />
              <span class="rc-faint" style="font-size: 11px" :title="edge.reason">{{ edge.confidence }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Relationships -->
      <div class="rc-panel" v-if="result.relationships.length > 0">
        <div class="rc-panel-header">Relationship Evidence ({{ result.relationships.length }})</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 6px; max-height: 200px; overflow-y: auto">
            <div v-for="(rel, idx) in result.relationships" :key="idx" style="font-size: 11px">
              <span class="rc-mono rc-muted">{{ rel.source }}</span>
              <span class="rc-badge neutral" style="font-size: 10px; padding: 1px 5px; margin: 0 4px">{{ rel.kind }}</span>
              <span class="rc-mono rc-muted">{{ rel.target }}</span>
              <span class="rc-faint" style="margin-left: 8px">{{ rel.reason }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Code snippets -->
      <div class="rc-panel">
        <div class="rc-panel-header">Code Snippets ({{ result.snippets.length }})</div>
        <div class="rc-panel-body rc-col" style="gap: 12px">
          <div v-for="(snippet, idx) in result.snippets" :key="idx" class="rc-panel">
            <div class="rc-panel-header" style="justify-content: space-between">
              <div class="rc-row" style="gap: 8px">
                <code class="rc-inline-code">{{ snippet.filePath }}:{{ snippet.startLine }}-{{ snippet.endLine }}</code>
                <span class="rc-badge neutral" style="font-size: 10px">{{ snippet.role }}</span>
                <span class="rc-badge" :class="scoreBadge(snippet.score)" style="font-size: 10px">
                  {{ snippet.score.toFixed(2) }}
                </span>
              </div>
              <span class="rc-faint rc-mono" style="font-size: 10px">{{ snippet.expansionLevel }}</span>
            </div>
            <div class="rc-panel-body" style="padding: 0">
              <pre class="rc-code" style="margin: 0; border: 0; border-radius: 0">{{ snippet.content }}</pre>
              <div v-if="snippet.elidedLineCount > 0" class="rc-muted" style="padding: 8px 12px; font-size: 11px; border-top: 1px solid var(--border)">
                {{ snippet.elidedLineCount }} lines elided
              </div>
            </div>
            <div class="rc-panel-body" style="padding: 8px 12px; border-top: 1px solid var(--border); font-size: 11px">
              {{ snippet.reason }}
            </div>
          </div>
        </div>
      </div>

      <!-- Next queries -->
      <div class="rc-panel" v-if="result.nextQueries.length > 0">
        <div class="rc-panel-header">Suggested Follow-up Queries</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 6px">
            <div v-for="(nq, idx) in result.nextQueries" :key="idx" class="rc-link" @click="query = nq; handleSearch()">
              {{ nq }}
            </div>
          </div>
        </div>
      </div>

      <!-- Missing evidence -->
      <div class="rc-panel" v-if="result.missingEvidence.length > 0">
        <div class="rc-panel-header">Missing Evidence</div>
        <div class="rc-panel-body">
          <div class="rc-col" style="gap: 4px">
            <div v-for="(me, idx) in result.missingEvidence" :key="idx" class="rc-muted" style="font-size: 12px">• {{ me }}</div>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="!searching" class="rc-empty">Enter a query above to retrieve context</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { contextApi, type ContextPack } from '../api/client'
import { useToast } from '../composables/toast'
import { confidenceClass, scoreBadge, shortPath, edgeColor } from '../utils/format'

const toast = useToast()
const query = ref('how does the context engine work')
const mode = ref<'auto' | 'debug' | 'feature' | 'refactor' | 'review' | 'explain'>('auto')
const budgetChars = ref(16000)
const searching = ref(false)
const result = ref<ContextPack | null>(null)

async function handleSearch() {
  if (!query.value.trim()) {
    toast.warning('Enter a query')
    return
  }
  searching.value = true
  result.value = null
  try {
    const { data } = await contextApi.get({ query: query.value, mode: mode.value, budgetChars: budgetChars.value })
    result.value = data
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    searching.value = false
  }
}
</script>
