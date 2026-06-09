import { defineStore } from 'pinia'
import { ref } from 'vue'
import { indexApi, type IndexStatus } from '../api/client'

export const useRepoStore = defineStore('repo', () => {
  const status = ref<IndexStatus | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function refreshStatus() {
    loading.value = true
    error.value = null
    try {
      const { data } = await indexApi.status()
      status.value = data
    } catch (e: any) {
      // 409 = engine not yet initialized; treat as empty state, not a hard error.
      if (e?.response?.status === 409) {
        status.value = null
      } else {
        error.value = e?.response?.data?.error ?? e.message
      }
    } finally {
      loading.value = false
    }
  }

  return { status, loading, error, refreshStatus }
})
