// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import { RouterView } from 'vue-router'
import { router } from './router'
import { applyRegistryFrameOrigins } from './lib/csp-frame'
import './styles.css'
import './tokens.css'

// 根组件只渲染当前路由视图（App.vue 是 '/' 路由的工作台壳，#12）
createApp(RouterView).use(router).mount('#app')

// 外壳 CSP frame-src 动态收紧（决策 #63/#73）：启动时拉注册表白名单重写 meta。
// 失败静默维持 'self' 基线（fail-closed）；响应头权威在 core Worker 侧。
void applyRegistryFrameOrigins(document)
