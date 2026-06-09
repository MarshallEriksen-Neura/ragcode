import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', name: 'Overview', component: () => import('./views/OverviewView.vue') },
    { path: '/context', name: 'Context', component: () => import('./views/ContextView.vue') },
    { path: '/graph', name: 'Graph', component: () => import('./views/GraphView.vue') },
    { path: '/impact', name: 'Impact', component: () => import('./views/ImpactView.vue') },
    { path: '/watch', name: 'Watch', component: () => import('./views/WatchView.vue') },
    { path: '/config', name: 'Config', component: () => import('./views/ConfigView.vue') },
  ],
})

export default router
