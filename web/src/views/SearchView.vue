<template>
  <n-space vertical :size="24">
    <n-card title="检索调试">
      <n-space vertical>
        <n-input
          v-model:value="query"
          type="textarea"
          placeholder="输入检索查询..."
          :rows="3"
        />
        <n-space>
          <n-select
            v-model:value="mode"
            :options="modeOptions"
            style="width: 200px"
          />
          <n-button type="primary" :loading="searching" @click="handleSearch">
            检索
          </n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card v-if="result" title="检索结果">
      <n-space vertical :size="16">
        <n-descriptions bordered :column="2">
          <n-descriptions-item label="模式">{{ result.mode }}</n-descriptions-item>
          <n-descriptions-item label="结果数">{{ result.snippets?.length || 0 }}</n-descriptions-item>
          <n-descriptions-item label="简要说明" :span="2">
            {{ result.brief }}
          </n-descriptions-item>
        </n-descriptions>

        <n-divider />

        <div v-if="result.snippets && result.snippets.length > 0">
          <h3>代码片段</h3>
          <n-space vertical :size="12">
            <n-card
              v-for="(snippet, idx) in result.snippets"
              :key="idx"
              size="small"
              :title="`${snippet.file}:${snippet.startLine}-${snippet.endLine}`"
            >
              <template #header-extra>
                <n-tag :type="getScoreType(snippet.score)">
                  得分: {{ snippet.score.toFixed(2) }}
                </n-tag>
              </template>
              <n-code :code="snippet.content" language="typescript" />
              <template #footer>
                <n-text depth="3">{{ snippet.reason }}</n-text>
              </template>
            </n-card>
          </n-space>
        </div>

        <n-alert v-else type="info">
          未找到相关结果
        </n-alert>
      </n-space>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { searchApi } from '../api/client'

const message = useMessage()
const searching = ref(false)
const query = ref('context engine')
const mode = ref<'auto' | 'debug' | 'feature' | 'refactor' | 'review' | 'explain'>('auto')
const result = ref<any>(null)

const modeOptions = [
  { label: 'Auto (自动模式)', value: 'auto' },
  { label: 'Debug (调试)', value: 'debug' },
  { label: 'Feature (功能开发)', value: 'feature' },
  { label: 'Refactor (重构)', value: 'refactor' },
  { label: 'Review (代码审查)', value: 'review' },
  { label: 'Explain (解释说明)', value: 'explain' },
]

const getScoreType = (score: number) => {
  if (score >= 0.8) return 'success'
  if (score >= 0.5) return 'warning'
  return 'default'
}

const handleSearch = async () => {
  if (!query.value.trim()) {
    message.warning('请输入检索内容')
    return
  }

  searching.value = true
  try {
    const { data } = await searchApi.search({
      query: query.value,
      mode: mode.value,
    })
    result.value = data
  } catch (error: any) {
    message.error('检索失败: ' + error.message)
  } finally {
    searching.value = false
  }
}
</script>
