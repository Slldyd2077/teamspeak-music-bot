import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router/index.js';
import { installApiClient } from './api/http.js';
import './styles/global.scss';
import './styles/mobile.scss';

installApiClient();

const app = createApp(App);
app.use(createPinia());
app.use(router);
// Wait for the initial navigation (and the beforeEach guard that reads ?bot)
// to fully resolve before mounting, so the reactive route query is populated
// when App.onMounted runs and the dedicated-bot scope locks the right bot.
// .catch keeps parity with the old unconditional mount: if the initial
// navigation errors (e.g. a transient network failure in the auth guard),
// still render the shell rather than leaving a blank page.
router.isReady().catch(() => {}).then(() => app.mount('#app'));
