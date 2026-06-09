<template>
  <n-space vertical :size="24">
    <n-card title="索引管理">
      <n-space vertical>
        <n-space>
          <n-input
            v-model:value="repoPath"
            placeholder="输入仓库路径 (例: d:/projects/myapp)"
            style="width: 400px"
          />
          <n-button type="primary" :loading="indexing" @click="handleIndex">
            {{ indexing ? '索引中...' : '开始索引' }}
          </n-button>
          <n-button @click="handleRefresh">刷新统计</n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-grid cols="4" x-gap="16" y-gap="16">
      <n-gi>
        <n-card>
          <n-statistic label="文件数" :value="stats.filesCount">
            <template #prefix>📄</template>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card>
          <n-statistic label="符号数" :value="stats.symbolsCount">
            <template #prefix>🔤</template>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card>
          <n-statistic label="代码块数" :value="stats.chunksCount">
            <template #prefix>🧩</template>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card>
          <n-statistic label="关系边数" :value="stats.edgesCount">
            <template #prefix>🔗</template>
          </n-statistic>
        </n-card>
      </n-gi>
    </n-grid>

    <n-card title="索引状态">
      <n-space vertical>
        <n-alert v-if="!hasIndex" type="info">
          尚未建立索引，请先输入仓库路径并点击"开始索引"
        </n-alert>
        <n-alert v-else type="success">
          索引已建立，共 {{ stats.filesCount }} 个文件，{{ stats.symbolsCount }} 个符号
        </n-alert>
      </n-space>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { indexApi, type IndexStats } from '../api/client'

const message = useMessage()
const indexing = ref(false)
const repoPath = ref('d:/20260302170616/ragcode')

const stats = ref<IndexStats>({
  filesCount: 0,
  symbolsCount: 0,
  chunksCount: 0,
  edgesCount: 0,
  storageSize: 0,
})

const hasIndex = computed(() => stats.value.filesCount > 0)

const loadStats = async () => {
  try {
    const { data } = await indexApi.getStats()
    stats.value = data
  } catch (error: any) {
    // Engine not initialized yet
    console.log('Stats not available:', error.message)
  }
}

const handleIndex = async () => {
  if (!repoPath.value.trim()) {
    message.warning('请输入仓库路径')
    return
  }

  indexing.value = true
  try {
    await indexApi.triggerIndex(repoPath.value)
    message.success('索引完成')
    await loadStats()
  } catch (error: any) {
    message.error('索引失败: ' + error.message)
  } finally {
    indexing.value = false
  }
}

const handleRefresh = () => {
  loadStats()
}

onMounted(() => {
  loadStats()
})
</script>
