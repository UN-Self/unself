// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

// 独立开发态令牌兜底（§6.5.5）：仅 dev server 生效，动态引入壳的 tokens.css
// （该文件是仓库唯一令牌取值定义处，verify-tokens 豁免）；生产构建常量折叠剔除，产物零令牌值。
if (import.meta.env.DEV) {
  await import('../../../../../apps/shell/src/tokens.css')
}

createApp(App).mount('#app')
