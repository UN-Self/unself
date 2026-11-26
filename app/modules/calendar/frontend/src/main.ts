// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import App from './App.vue'

// 开发态加载工作台令牌（照 chat 模块写法）；生产构建会常量折叠剔除
if (import.meta.env.DEV) {
  await import('../../../../../app/workbench/web/src/tokens.css')
}

createApp(App).mount('#app')
