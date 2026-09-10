// SPDX-License-Identifier: AGPL-3.0-only
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import App from './App.vue'
import ActivateView from './ActivateView.vue'
import InviteView from './InviteView.vue'
import LoginView from './LoginView.vue'
import SetupView from './SetupView.vue'
import { decideSetupAccess } from './lib/setup-guard'
import { getSetupStatus } from './lib/setup-api'
import { loginUrl } from './lib/session-api'
import { installAuthGuard } from './lib/guarded-fetch'

/**
 * M0 路由：/setup 向导（守卫见下）、/login 登录页（#11）、/ 登录后工作台（#12 完整化）。
 * #17：/admin 管理台五页（布局组件内做 role 守卫；服务端 /api/admin/* 有真值守卫）。
 * #18：公开邀请填表 /invite/:token 与激活 /activate/:token（无侧栏独立壳，不登登录）。
 */

const routes: RouteRecordRaw[] = [
  { path: '/', component: App },
  { path: '/login', component: LoginView },
  { path: '/invite/:token', component: InviteView },
  { path: '/activate/:token', component: ActivateView },
  { path: '/setup', component: SetupView },
  {
    path: '/admin',
    component: () => import('./AdminLayout.vue'),
    children: [
      { path: '', redirect: '/admin/members' },
      { path: 'members', component: () => import('./admin/MembersPage.vue') },
      { path: 'invites', component: () => import('./admin/InvitesPage.vue') },
      { path: 'modules', component: () => import('./admin/ModulesPage.vue') },
      { path: 'audit', component: () => import('./admin/AuditPage.vue') },
      { path: 'settings', component: () => import('./admin/SettingsPage.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

/** 401 全局拦截：整页跳登录并带 next 回跳（#11 会话态）。 */
installAuthGuard((next) => {
  window.location.assign(loginUrl(next))
})

/** /setup 守卫：已激活 → 已登录进工作台 / 未登录去登录页（§6.5「页面不复存在」）。 */
router.beforeEach(async (to) => {
  if (to.path !== '/setup') {
    return true
  }
  const token = typeof to.query.token === 'string' ? to.query.token : undefined
  try {
    const status = await getSetupStatus(token)
    const me = await fetch('/api/me', { credentials: 'same-origin' })
    const decision = decideSetupAccess({
      setupDone: status.done,
      hasToken: Boolean(token),
      authenticated: me.ok,
    })
    if (decision === 'redirect-workspace') return '/'
    if (decision === 'redirect-login') return '/login'
    return true
  } catch {
    // 后端不可达：放行向导页，由页面内提示网络问题
    return true
  }
})
