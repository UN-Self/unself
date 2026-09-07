// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles.css'
import './tokens.css'

createApp(App).use(router).mount('#app')
