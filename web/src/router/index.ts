import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/Home.vue'),
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('../views/Search.vue'),
    },
    {
      path: '/library',
      name: 'library',
      component: () => import('../views/Library.vue'),
    },
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('../views/Playlist.vue'),
    },
    {
      path: '/lyrics',
      name: 'lyrics',
      component: () => import('../views/Lyrics.vue'),
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('../views/History.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/Settings.vue'),
    },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('../views/Setup.vue'),
    },
    {
      // Per-bot URL: /bot/:id — sets active bot then redirects to home
      path: '/bot/:id',
      name: 'bot',
      component: () => import('../views/BotRedirect.vue'),
    },
  ],
});

export default router;
