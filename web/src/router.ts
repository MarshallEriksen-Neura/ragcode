import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/config',
      name: 'Config',
      component: () => import('./views/ConfigView.vue'),
    },
    {
      path: '/dashboard',
      name: 'Dashboard',
      component: () => import('./views/DashboardView.vue'),
    },
    {
      path: '/graph',
      name: 'Graph',
      component: () => import('./views/GraphView.vue'),
    },
    {
      path: '/search',
      name: 'Search',
      component: () => import('./views/SearchView.vue'),
    },
    {
      path: '/watch',
      name: 'Watch',
      component: () => import('./views/WatchView.vue'),
    },
  ],
})

export default router
