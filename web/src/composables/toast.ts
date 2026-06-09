import { reactive } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'info' | 'warning'
}

const state = reactive<{ toasts: Toast[] }>({ toasts: [] })
let counter = 0

function push(message: string, type: Toast['type']) {
  const id = counter++
  state.toasts.push({ id, message, type })
  setTimeout(() => {
    const idx = state.toasts.findIndex((t) => t.id === id)
    if (idx >= 0) state.toasts.splice(idx, 1)
  }, 3500)
}

export function useToast() {
  return {
    toasts: state.toasts,
    success: (m: string) => push(m, 'success'),
    error: (m: string) => push(m, 'error'),
    info: (m: string) => push(m, 'info'),
    warning: (m: string) => push(m, 'warning'),
  }
}
