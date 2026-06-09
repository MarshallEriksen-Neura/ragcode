<template>
  <div class="toast-container">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="toast.type"
    >
      {{ toast.message }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useToast } from '../composables/toast'

const { toasts } = useToast()
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
  min-width: 220px;
  max-width: 400px;
  font-size: 13px;
  box-shadow: var(--shadow);
  pointer-events: auto;
  animation: slideIn 0.2s ease-out;
}
@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
.toast.success { border-color: var(--success); background: var(--success-muted); }
.toast.error { border-color: var(--danger); background: var(--danger-muted); }
.toast.warning { border-color: var(--warning); background: var(--warning-muted); }
.toast.info { border-color: var(--info); background: var(--info-muted); }
</style>
