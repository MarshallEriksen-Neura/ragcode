<template>
  <div class="rc-col">
    <h1 class="rc-page-title">Impact & Analysis</h1>
    <p class="rc-page-sub">Impact analysis, call tracing, related tests, and reuse candidates</p>

    <!-- Input -->
    <div class="rc-panel">
      <div class="rc-panel-body">
        <div class="rc-row" style="gap: 10px">
          <input v-model="target" class="rc-input" placeholder="Target symbol or file (e.g., UserService or src/auth.ts)" style="flex: 1" />
          <button class="rc-btn" :disabled="loading" @click="runImpact">Impact</button>
          <button class="rc-btn" :disabled="loading" @click="runTrace">Trace</button>
          <button class="rc-btn" :disabled="loading" @click="runTests">Tests</button>
          <button class="rc-btn" :disabled="loading" @click="runReuse">Reuse</button>
        </div>
      </div>
    </div>

    <!-- Impact Analysis -->
    <template v-if="impact">
      <div class="rc-row rc-wrap" style="gap: 10px">
        <span class="rc-badge" :class="riskClass(impact.riskLevel)">Risk: {{ impact.riskLevel }}</span>
        <span class="rc-badge neutral">{{ impact.matchedSymbols.length }} matched</span>
        <span class="rc-badge neutral">{{ impact.impactedFiles.length }} impacted files</span>
        <span class="rc-badge info">{{ impact.incomingEdges.length }} ← incoming</span>
        <span class="rc-badge accent">{{ impact.outgoingEdges.length }} → outgoing</span>
      </div>

      <div class="rc-panel">
        <div class="rc-panel-header">Minimal Context Pack ({{ impact.minimalPack.length }})</div>
        <div class="rc-panel-body rc-col" style="gap: 8px">
          <div v-for="(item, idx) in impact.minimalPack" :key="idx" class="rc-row" style="gap: 10px; align-items: flex-start">
            <span class="rc-badge info" style="flex-shrink: 0">{{ item.role }}</span>
            <div class="rc-col" style="gap: 4px; flex: 1">
              <code class="rc-inline-code">{{ item.filePath }}</code>
              <div class="rc-muted" style="font-size: 12px">{{ item.reason }}</div>
              <div v-if="item.symbols.length > 0" class="rc-row rc-wrap" style="gap: 6px; margin-top: 4px">
                <span v-for="(sym, si) in item.symbols" :key="si" class="rc-mono rc-faint" style="font-size: 11px">
                  {{ sym.name }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="rc-panel" v-if="impact.references.length > 0">
        <div class="rc-panel-header">References ({{ impact.references.length }})</div>
        <div class="rc-panel-body rc-col" style="gap: 6px; max-height: 300px; overflow-y: auto">
          <div v-for="(ref, idx) in impact.references" :key="idx" style="font-size: 11px">
            <span class="rc-mono rc-muted">{{ shortPath(ref.sourceFile ?? ref.sourceSymbol ?? '?', 30) }}</span>
            <span class="rc-badge neutral" style="font-size: 10px; margin: 0 4px; padding: 1px 5px">{{ ref.edge }}</span>
            <span class="rc-mono rc-muted">{{ shortPath(ref.targetFile ?? ref.targetSymbol ?? ref.targetName ?? '?', 30) }}</span>
            <span class="rc-faint" style="margin-left: 8px">{{ ref.confidence }}</span>
          </div>
        </div>
      </div>

      <div class="rc-panel" v-if="impact.nextQueries.length > 0">
        <div class="rc-panel-header">Next Queries</div>
        <div class="rc-panel-body rc-col" style="gap: 4px">
          <div v-for="(nq, idx) in impact.nextQueries" :key="idx" class="rc-link" @click="target = nq; runImpact()">
            {{ nq }}
          </div>
        </div>
      </div>
    </template>

    <!-- Trace Flow -->
    <template v-if="trace">
      <div class="rc-panel">
        <div class="rc-panel-header">
          Call Trace from <code style="color: var(--accent)">{{ trace.entry }}</code>
          <span v-if="trace.truncated" class="rc-badge warning" style="margin-left: 8px">truncated</span>
        </div>
        <div class="rc-panel-body rc-col" style="gap: 6px">
          <div v-for="(step, idx) in trace.steps" :key="idx" class="rc-row" style="gap: 8px; font-size: 12px">
            <span class="rc-faint" style="width: 24px; text-align: right">{{ idx + 1 }}</span>
            <span class="rc-badge neutral" style="font-size: 10px; padding: 1px 6px">{{ step.kind }}</span>
            <code class="rc-inline-code">{{ step.symbolName }}</code>
            <span v-if="step.targetName" class="rc-muted">→ {{ step.targetName }}</span>
            <div class="rc-spacer" />
            <span class="rc-mono rc-faint" style="font-size: 10px">{{ shortPath(step.filePath, 32) }}</span>
          </div>
          <div v-if="trace.steps.length === 0" class="rc-empty">No trace steps found</div>
        </div>
      </div>
    </template>

    <!-- Related Tests -->
    <template v-if="tests">
      <div class="rc-panel">
        <div class="rc-panel-header">
          Related Tests for <code style="color: var(--accent)">{{ tests.target }}</code>
        </div>
        <div class="rc-panel-body">
          <div v-if="tests.tests.length > 0" class="rc-col" style="gap: 6px">
            <code v-for="(test, idx) in tests.tests" :key="idx" class="rc-inline-code" style="display: block">
              {{ test.path }}
            </code>
          </div>
          <div v-else class="rc-empty" style="padding: 20px">No related tests found</div>

          <div v-if="tests.missingLikelyTests.length > 0" class="rc-divider" />
          <div v-if="tests.missingLikelyTests.length > 0">
            <div class="rc-muted" style="margin-bottom: 6px; font-size: 11px">Missing likely tests:</div>
            <div class="rc-col" style="gap: 4px">
              <div v-for="(missing, idx) in tests.missingLikelyTests" :key="idx" class="rc-faint" style="font-size: 12px">
                • {{ missing }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Reuse Candidates -->
    <template v-if="reuse">
      <div class="rc-row rc-wrap" style="gap: 10px">
        <span class="rc-badge" :class="reuse.decision === 'reuse' ? 'success' : 'warning'">
          Decision: {{ reuse.decision }}
        </span>
        <span class="rc-badge" :class="confidenceClass(reuse.confidence)">{{ reuse.confidence }}</span>
        <span class="rc-badge" :class="riskClass(reuse.duplicateRisk)">Duplicate risk: {{ reuse.duplicateRisk }}</span>
        <span class="rc-badge neutral">{{ reuse.candidates.length }} candidates</span>
      </div>

      <div class="rc-panel" v-if="reuse.candidates.length > 0">
        <div class="rc-panel-header">Reuse Candidates</div>
        <div class="rc-panel-body rc-col" style="gap: 12px">
          <div v-for="(cand, idx) in reuse.candidates" :key="idx" class="rc-panel">
            <div class="rc-panel-header">
              <code class="rc-inline-code">{{ cand.filePath }}{{ cand.symbolName ? `:${cand.symbolName}` : '' }}</code>
              <div class="rc-spacer" />
              <span class="rc-badge" :class="confidenceClass(cand.confidence)">{{ cand.confidence }}</span>
              <span class="rc-badge" :class="scoreBadge(cand.score)">{{ cand.score.toFixed(2) }}</span>
            </div>
            <div class="rc-panel-body rc-col" style="gap: 8px">
              <div class="rc-row rc-wrap" style="gap: 6px">
                <span class="rc-badge neutral">{{ cand.kind }}</span>
                <span v-if="cand.exported" class="rc-badge success">exported</span>
                <span class="rc-mono rc-faint" style="font-size: 11px">{{ cand.callerCount }} callers</span>
                <span class="rc-mono rc-faint" style="font-size: 11px">{{ cand.relatedTestCount }} tests</span>
              </div>
              <div v-if="cand.whyReuse.length > 0" class="rc-col" style="gap: 4px">
                <div class="rc-muted" style="font-size: 11px">Why reuse:</div>
                <div v-for="(why, wi) in cand.whyReuse" :key="wi" class="rc-muted" style="font-size: 12px">• {{ why }}</div>
              </div>
              <div v-if="cand.reasons.length > 0" class="rc-col" style="gap: 2px; margin-top: 4px">
                <div v-for="(reason, ri) in cand.reasons" :key="ri" class="rc-faint" style="font-size: 11px">{{ reason }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="rc-panel" v-if="reuse.nextQueries.length > 0">
        <div class="rc-panel-header">Next Queries</div>
        <div class="rc-panel-body rc-col" style="gap: 4px">
          <div v-for="(nq, idx) in reuse.nextQueries" :key="idx" class="rc-link" @click="target = nq; runReuse()">
            {{ nq }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { analysisApi, type ImpactAnalysis, type TraceFlow, type RelatedTests, type ReuseCandidateReport } from '../api/client'
import { useToast } from '../composables/toast'
import { confidenceClass, riskClass, scoreBadge, shortPath } from '../utils/format'

const toast = useToast()
const target = ref('RagCodeEngine')
const loading = ref(false)
const impact = ref<ImpactAnalysis | null>(null)
const trace = ref<TraceFlow | null>(null)
const tests = ref<RelatedTests | null>(null)
const reuse = ref<ReuseCandidateReport | null>(null)

function clearResults() {
  impact.value = null
  trace.value = null
  tests.value = null
  reuse.value = null
}

async function runImpact() {
  if (!target.value.trim()) {
    toast.warning('Enter a target')
    return
  }
  loading.value = true
  clearResults()
  try {
    const { data } = await analysisApi.impact(target.value)
    impact.value = data
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    loading.value = false
  }
}

async function runTrace() {
  if (!target.value.trim()) {
    toast.warning('Enter a target')
    return
  }
  loading.value = true
  clearResults()
  try {
    const { data } = await analysisApi.trace(target.value, 20)
    trace.value = data
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    loading.value = false
  }
}

async function runTests() {
  if (!target.value.trim()) {
    toast.warning('Enter a target')
    return
  }
  loading.value = true
  clearResults()
  try {
    const { data } = await analysisApi.relatedTests(target.value)
    tests.value = data
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    loading.value = false
  }
}

async function runReuse() {
  if (!target.value.trim()) {
    toast.warning('Enter a target')
    return
  }
  loading.value = true
  clearResults()
  try {
    const { data } = await analysisApi.reuse(target.value, 8)
    reuse.value = data
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    loading.value = false
  }
}
</script>
