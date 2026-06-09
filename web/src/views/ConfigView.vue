<template>
  <n-space vertical :size="24">
    <n-card title="系统配置">
      <n-spin :show="loading">
        <n-form
          ref="formRef"
          :model="formValue"
          label-placement="left"
          label-width="150px"
        >
          <n-form-item label="Graph Store" path="graphStore">
            <n-select
              v-model:value="formValue.graphStore"
              :options="graphStoreOptions"
            />
          </n-form-item>

          <n-form-item label="Semantic Store" path="semanticStore">
            <n-select
              v-model:value="formValue.semanticStore"
              :options="semanticStoreOptions"
            />
          </n-form-item>

          <n-form-item label="Embedding Provider" path="embeddingProvider">
            <n-select
              v-model:value="formValue.embeddingProvider"
              :options="embeddingProviderOptions"
            />
          </n-form-item>

          <n-form-item label="SQLite Path" path="sqlitePath">
            <n-input
              v-model:value="formValue.sqlitePath"
              placeholder=".ragcode/graph.sqlite"
            />
          </n-form-item>

          <n-form-item label="LanceDB URI" path="lancedbUri">
            <n-input
              v-model:value="formValue.lancedbUri"
              placeholder=".ragcode/lancedb"
            />
          </n-form-item>

          <n-form-item>
            <n-space>
              <n-button type="primary" @click="handleSave">
                保存配置
              </n-button>
              <n-button @click="handleReset">重置</n-button>
            </n-space>
          </n-form-item>
        </n-form>
      </n-spin>
    </n-card>

    <n-card title="配置说明">
      <n-ul>
        <n-li><strong>Graph Store</strong>: 代码结构存储引擎（memory 用于测试，sqlite 用于生产）</n-li>
        <n-li><strong>Semantic Store</strong>: 向量存储引擎（memory 用于测试，lancedb 用于生产）</n-li>
        <n-li><strong>Embedding Provider</strong>: 向量化模型（deterministic 离线测试，openai 需要 API key）</n-li>
      </n-ul>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { configApi, type Config } from '../api/client'

const message = useMessage()
const loading = ref(false)
const formRef = ref()

const formValue = ref<Config>({
  graphStore: 'memory',
  semanticStore: 'memory',
  embeddingProvider: 'deterministic',
  sqlitePath: '',
  lancedbUri: '',
})

const graphStoreOptions = [
  { label: 'Memory (测试)', value: 'memory' },
  { label: 'SQLite (生产)', value: 'sqlite' },
]

const semanticStoreOptions = [
  { label: 'Memory (测试)', value: 'memory' },
  { label: 'LanceDB (生产)', value: 'lancedb' },
]

const embeddingProviderOptions = [
  { label: 'Deterministic (离线)', value: 'deterministic' },
  { label: 'OpenAI Compatible', value: 'openai' },
]

const loadConfig = async () => {
  loading.value = true
  try {
    const { data } = await configApi.getConfig()
    formValue.value = data
  } catch (error: any) {
    message.error('加载配置失败: ' + error.message)
  } finally {
    loading.value = false
  }
}

const handleSave = async () => {
  loading.value = true
  try {
    await configApi.updateConfig(formValue.value)
    message.success('配置已保存（重启服务生效）')
  } catch (error: any) {
    message.error('保存失败: ' + error.message)
  } finally {
    loading.value = false
  }
}

const handleReset = () => {
  loadConfig()
}

onMounted(() => {
  loadConfig()
})
</script>
