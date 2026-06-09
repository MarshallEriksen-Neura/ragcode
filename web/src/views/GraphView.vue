<template>
  <div class="rc-col">
    <h1 class="rc-page-title">Code Graph</h1>
    <p class="rc-page-sub">Visualize symbols and relationships across the codebase</p>

    <div class="rc-panel">
      <div class="rc-panel-body">
        <div class="rc-row rc-wrap" style="gap: 10px">
          <select v-model="languageFilter" class="rc-select" style="width: 140px">
            <option value="">All languages</option>
            <option v-for="lang in availableLanguages" :key="lang" :value="lang">{{ lang }}</option>
          </select>
          <select v-model="kindFilter" class="rc-select" style="width: 140px">
            <option value="">All kinds</option>
            <option value="function">function</option>
            <option value="class">class</option>
            <option value="method">method</option>
            <option value="type">type</option>
            <option value="variable">variable</option>
          </select>
          <input v-model.number="limitNodes" type="number" class="rc-input" placeholder="Limit" style="width: 100px" min="10" max="1000" />
          <button class="rc-btn primary" @click="loadGraph" :disabled="loading">
            {{ loading ? 'Loading...' : 'Load Graph' }}
          </button>
          <div class="rc-spacer" />
          <span v-if="graphData" class="rc-mono rc-muted" style="font-size: 11px">
            {{ graphData.shown }} / {{ graphData.total }} nodes · {{ graphData.edges.length }} edges
          </span>
        </div>
      </div>
    </div>

    <div v-if="graphData" class="rc-panel">
      <div class="rc-panel-body" style="padding: 0">
        <div ref="chartRef" style="width: 100%; height: 600px" />
      </div>
    </div>

    <div v-else-if="!loading" class="rc-empty">Click "Load Graph" to visualize code relationships</div>

    <!-- Selected node panel -->
    <div v-if="selectedNode" class="rc-panel">
      <div class="rc-panel-header">{{ selectedNode.label }} <span class="rc-faint">({{ selectedNode.kind }})</span></div>
      <div class="rc-panel-body rc-col" style="gap: 8px">
        <div><code class="rc-inline-code">{{ selectedNode.filePath }}:{{ selectedNode.startLine }}</code></div>
        <div v-if="selectedNode.signature" class="rc-code" style="font-size: 11px; white-space: pre-wrap">
          {{ selectedNode.signature }}
        </div>
        <div v-if="selectedNode.exported" class="rc-badge success" style="align-self: flex-start">exported</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import * as echarts from 'echarts'
import { graphApi, type GraphNode, type GraphResponse } from '../api/client'
import { useToast } from '../composables/toast'
import { edgeColor, langColor } from '../utils/format'

const toast = useToast()
const loading = ref(false)
const graphData = ref<GraphResponse | null>(null)
const chartRef = ref<HTMLElement>()
const languageFilter = ref('')
const kindFilter = ref('')
const limitNodes = ref(300)
const selectedNode = ref<GraphNode | null>(null)

let chart: echarts.ECharts | null = null

const availableLanguages = computed(() => {
  if (!graphData.value) return []
  const langs = new Set(graphData.value.nodes.map((n) => n.language))
  return [...langs].sort()
})

async function loadGraph() {
  loading.value = true
  try {
    const { data } = await graphApi.get({
      language: languageFilter.value || undefined,
      kind: kindFilter.value || undefined,
      limit: limitNodes.value,
    })
    graphData.value = data
    await nextTick()
    renderGraph()
  } catch (error: any) {
    toast.error(error?.response?.data?.error ?? error.message)
  } finally {
    loading.value = false
  }
}

function renderGraph() {
  if (!chartRef.value || !graphData.value) return

  if (!chart) {
    chart = echarts.init(chartRef.value, 'dark')
  }

  const nodes = graphData.value.nodes.map((node) => ({
    id: node.id,
    name: node.label,
    symbolSize: node.kind === 'class' ? 22 : node.kind === 'function' ? 16 : 12,
    category: node.language,
    itemStyle: {
      color: langColor(node.language),
    },
    label: {
      show: graphData.value!.shown < 80,
      fontSize: 10,
    },
    // Store original for click handler
    _raw: node,
  }))

  const links = graphData.value.edges.map((edge) => ({
    source: edge.sourceId,
    target: edge.targetId,
    lineStyle: {
      color: edgeColor(edge.kind),
      curveness: 0.15,
      opacity: 0.6,
    },
    label: {
      show: false,
      formatter: edge.kind,
      fontSize: 9,
    },
  }))

  const categories = [...new Set(graphData.value.nodes.map((n) => n.language))].map((lang) => ({ name: lang }))

  const option: echarts.EChartsOption = {
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (params: any) => {
        if (params.dataType === 'node') {
          const node = params.data._raw as GraphNode
          return `<b>${node.label}</b><br/>${node.kind} · ${node.language}<br/>${node.filePath}:${node.startLine}`
        }
        return `${params.data.source} → ${params.data.target}`
      },
    },
    legend: {
      data: categories.map((c) => c.name),
      textStyle: { color: '#adbac7', fontSize: 11 },
      top: 10,
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        data: nodes,
        links,
        categories,
        roam: true,
        draggable: true,
        force: {
          repulsion: graphData.value.shown > 100 ? 180 : 120,
          edgeLength: graphData.value.shown > 100 ? 60 : 90,
          gravity: 0.15,
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: 3 },
        },
      },
    ],
  }

  chart.setOption(option, true)

  chart.off('click')
  chart.on('click', (params: any) => {
    if (params.dataType === 'node') {
      selectedNode.value = params.data._raw as GraphNode
    }
  })
}
</script>
