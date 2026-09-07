// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from 'vue'
import { RouterView } from 'vue-router'
import { router } from './router'
import './styles.css'
import './tokens.css'

// 根组件只渲染当前路由视图（App.vue 是 '/' 路由的工作台壳，#12）
createApp(RouterView).use(router).mount('#app')
