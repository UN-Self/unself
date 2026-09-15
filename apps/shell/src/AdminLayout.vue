<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { ArrowLeft, Blocks, LayoutDashboard, MailPlus, ScrollText, Settings, Users } from 'lucide-vue-next'

import { fetchMe } from './lib/session-api'

/**
 * 管理台布局（#17 /admin 骨架）：
 * - 守卫：/api/me role 判定，非 admin / 未登录重定向（前端视图守卫；真值守卫在服务端 /api/admin/*）
 * - 桌面 = 左侧导航 + 内容区；窄屏 = 导航折叠为顶部横排（两视口同份数据）
 * - 页面本体走 <RouterView>，导航选中态由路由驱动
 */

const router = useRouter()

/** admin 守卫通过后才渲染内容（redirect 决策在 onMounted 一次性完成）。 */
const allowed = ref(false)

const NAV = [
  { to: '/admin/members', label: '成员', icon: Users },
  { to: '/admin/invites', label: '邀请', icon: MailPlus },
  { to: '/admin/modules', label: '模块', icon: Blocks },
  { to: '/admin/audit', label: '审计', icon: ScrollText },
  { to: '/admin/settings', label: '设置', icon: Settings },
] as const

onMounted(async () => {
  const me = await fetchMe()
  if (!me.authenticated) {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(next)}`)
    return
  }
  if (me.user.role !== 'admin') {
    // 非 admin：回工作台（服务端 /api/admin/* 另有真值守卫，这里只是不展示入口）
    router.replace('/')
    return
  }
  allowed.value = true
})
</script>

<template>
  <!-- 守卫判定完成前不渲染（避免非 admin 闪见管理界面） -->
  <div v-if="allowed" class="admin">
    <!-- 窄屏：顶部条（返回 + 导航横排） -->
    <header class="admin-topbar">
      <RouterLink class="admin-back" to="/">
        <ArrowLeft :size="16" aria-hidden="true" />
        工作台
      </RouterLink>
      <nav class="admin-topnav" aria-label="管理导航">
        <RouterLink
          v-for="item in NAV"
          :key="item.to"
          :to="item.to"
          class="admin-topnav-item"
        >
          <component :is="item.icon" :size="16" aria-hidden="true" />
          {{ item.label }}
        </RouterLink>
      </nav>
    </header>

    <div class="admin-body">
      <!-- 桌面：左侧导航 -->
      <aside class="admin-sidebar">
        <RouterLink class="admin-back admin-back-desktop" to="/">
          <ArrowLeft :size="16" aria-hidden="true" />
          返回工作台
        </RouterLink>
        <nav class="admin-nav" aria-label="管理导航">
          <RouterLink v-for="item in NAV" :key="item.to" :to="item.to" class="admin-nav-item">
            <component :is="item.icon" :size="18" aria-hidden="true" />
            {{ item.label }}
          </RouterLink>
        </nav>
        <RouterLink class="admin-nav-item admin-nav-workspace" to="/">
          <LayoutDashboard :size="18" aria-hidden="true" />
          工作台
        </RouterLink>
      </aside>

      <main class="admin-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
}
.admin-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ---------- 桌面左侧导航 ---------- */
.admin-sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  width: 200px;
  flex-shrink: 0;
  padding: var(--unself-space-4) var(--unself-space-2);
  border-right: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
}
.admin-back {
  display: none;
  align-items: center;
  gap: var(--unself-space-1);
  height: 32px;
  padding: 0 var(--unself-space-2);
  border-radius: var(--unself-radius-md);
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
  text-decoration: none;
}
.admin-back:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.admin-back-desktop {
  margin-bottom: var(--unself-space-2);
}
.admin-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.admin-nav-item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  height: 36px;
  padding: 0 var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-base);
  text-decoration: none;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.admin-nav-item:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.admin-nav-item.router-link-active {
  background: var(--unself-color-surface-active);
  color: var(--unself-color-text);
  font-weight: 500;
}
.admin-nav-workspace {
  margin-top: auto;
  color: var(--unself-color-text-tertiary);
}
/* 「工作台」入口非管理页：不参与选中态 */
.admin-nav-workspace.router-link-active {
  background: transparent;
  font-weight: 400;
}
.admin-nav-workspace:hover {
  background: var(--unself-color-surface-hover);
}

/* ---------- 内容区 ---------- */
.admin-content {
  flex: 1;
  min-width: 0;
  padding: var(--unself-space-6);
}

/* ---------- 窄屏：导航折叠为顶部 ---------- */
.admin-topbar {
  display: none;
}

@media (max-width: 768px) {
  .admin-sidebar {
    display: none;
  }
  .admin-topbar {
    display: flex;
    flex-direction: column;
    gap: var(--unself-space-2);
    padding: var(--unself-space-3) var(--unself-space-4);
    border-bottom: 1px solid var(--unself-color-border);
    background: var(--unself-color-surface);
  }
  .admin-back {
    display: inline-flex;
    align-self: flex-start;
  }
  .admin-topnav {
    display: flex;
    gap: var(--unself-space-1);
    overflow-x: auto;
  }
  .admin-topnav-item {
    display: inline-flex;
    align-items: center;
    gap: var(--unself-space-1);
    height: 32px;
    padding: 0 var(--unself-space-3);
    border-radius: var(--unself-radius-md);
    color: var(--unself-color-text-secondary);
    font-size: var(--unself-font-size-sm);
    text-decoration: none;
    white-space: nowrap;
  }
  .admin-topnav-item.router-link-active {
    background: var(--unself-color-surface-active);
    color: var(--unself-color-text);
    font-weight: 500;
  }
  .admin-content {
    padding: var(--unself-space-4);
  }
}
</style>
