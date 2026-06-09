<template>
  <n-space vertical :size="24">
    <n-card title="代码图谱可视化">
      <n-space vertical>
        <n-space>
          <n-button type="primary" :loading="loading" @click="loadGraph">
            加载图谱
          </n-button>
          <n-text depth="3">
            节点数: {{ nodes.length }} | 边数: {{ edges.length }}
          </n-text>
        </n-space>

        <div
          ref="chartRef"
          style="width: 100%; height: 600px; border: 1px solid #e0e0e0"
        />
      </n-space>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import { graphApi, type GraphNode, type GraphEdge } from '../api/client'
import * as echarts from 'echarts'

const message = useMessage()
const loading = ref(false)
const chartRef = ref<HTMLElement>()
const nodes = ref<GraphNode[]>([])
const edges = ref<GraphEdge[]>([])

let chartInstance: echarts.ECharts | null = null

const loadGraph = async () => {
  loading.value = true
  try {
    const { data } = await graphApi.getNodes()
    nodes.value = data.nodes
    edges.value = data.edges

    await nextTick()
    renderGraph()
  } catch (error: any) {
    message.error('加载图谱失败: ' + error.message)
  } finally {
    loading.value = false
  }
}

const renderGraph = () => {
  if (!chartRef.value) return

  if (!chartInstance) {
    chartInstance = echarts.init(chartRef.value)
  }

  // 转换为 ECharts 格式
  const graphNodes = nodes.value.map((node) => ({
    id: node.id,
    name: node.label,
    symbolSize: node.type === 'file' ? 30 : 20,
    category: node.type === 'file' ? 0 : 1,
    itemStyle: {
      color: node.type === 'file' ? '#5470c6' : '#91cc75',
    },
  }))

  const graphEdges = edges.value.map((edge) => ({
    source: edge.from,
    target: edge.to,
    label: { show: false, formatter: edge.type },
  }))

  const option = {
    title: {
      text: '代码依赖关系图',
      left: 'center',
    },
    tooltip: {
      formatter: (params: any) => {
        if (params.dataType === 'node') {
          return `${params.data.name}<br/>ID: ${params.data.id}`
        } else {
          return `${params.data.source} → ${params.data.target}`
        }
      },
    },
    legend: {
      data: ['文件', '符号'],
      top: 'bottom',
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        data: graphNodes,
        links: graphEdges,
        categories: [
          { name: '文件' },
          { name: '符号' },
        ],
        roam: true,
        label: {
          show: true,
          position: 'right',
          formatter: '{b}',
        },
        force: {
          repulsion: 100,
          edgeLength: 80,
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: {
            width: 3,
          },
        },
      },
    ],
  }

  chartInstance.setOption(option)
}

onMounted(() => {
  window.addEventListener('resize', () => {
    chartInstance?.resize()
  })
})
</script>
