<template>
  <n-config-provider :theme="theme">
    <n-loading-bar-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <n-message-provider>
            <n-layout style="height: 100vh">
              <n-layout-header bordered style="height: 64px; padding: 0 24px; display: flex; align-items: center">
                <h2 style="margin: 0">RagCode Dashboard</h2>
                <div style="margin-left: auto; display: flex; gap: 16px">
                  <n-switch v-model:value="isDark" @update:value="toggleTheme">
                    <template #checked>🌙</template>
                    <template #unchecked>☀️</template>
                  </n-switch>
                </div>
              </n-layout-header>
              <n-layout has-sider style="height: calc(100vh - 64px)">
                <n-layout-sider
                  bordered
                  show-trigger
                  collapse-mode="width"
                  :collapsed-width="64"
                  :width="240"
                >
                  <n-menu
                    :options="menuOptions"
                    :value="activeMenu"
                    @update:value="handleMenuSelect"
                  />
                </n-layout-sider>
                <n-layout-content content-style="padding: 24px">
                  <router-view />
                </n-layout-content>
              </n-layout>
            </n-layout>
          </n-message-provider>
        </n-notification-provider>
      </n-dialog-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { darkTheme, type GlobalTheme } from 'naive-ui'
import type { MenuOption } from 'naive-ui'

const router = useRouter()
const route = useRoute()

const isDark = ref(false)
const theme = computed<GlobalTheme | null>(() => (isDark.value ? darkTheme : null))

const toggleTheme = () => {
  // 主题切换逻辑
}

const activeMenu = computed(() => route.path)

const menuOptions: MenuOption[] = [
  {
    label: '配置管理',
    key: '/config',
    icon: () => h('span', '⚙️'),
  },
  {
    label: '索引仪表盘',
    key: '/dashboard',
    icon: () => h('span', '📊'),
  },
  {
    label: '代码图谱',
    key: '/graph',
    icon: () => h('span', '🕸️'),
  },
  {
    label: '检索调试',
    key: '/search',
    icon: () => h('span', '🔍'),
  },
  {
    label: '实时监控',
    key: '/watch',
    icon: () => h('span', '👁️'),
  },
]

const handleMenuSelect = (key: string) => {
  router.push(key)
}
</script>
