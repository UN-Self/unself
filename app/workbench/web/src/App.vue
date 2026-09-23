<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { LogOut, LayoutDashboard, KeyRound, ShieldCheck, User } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { UButton, UErrorCard, USkeleton } from '@unself/ui'

import ModuleHost from './ModuleHost.vue'
import NotificationBell from './NotificationBell.vue'
import { resolveLanding } from './lib/landing'
import { buildNav, isHostView, type NavItem } from './lib/nav'
import { fetchEnabledModules, type ApiError, type RegistryModule } from './lib/registry-api'
import { fetchMe, logout } from './lib/session-api'
import { moduleInitial, resolveModuleIcon } from './lib/module-icon'
import { useLayerFocus } from './lib/use-layer-focus'

/**
 * 工作台壳（#12，§6.5 动线；#83 拆分后只剩布局与导航）：
 * （#307 注：本文件无 <router-view>——整页路由视图在 main.ts 根 RouterView，
 * 路由切换 Transition 落在那里；壳内主区是 iframe 模块宿主，切换不做动画——
 * iframe 重载期间动画只会放大白屏感知。）
 * - 桌面 = 220px 左栏（顶部实例名 / 中部模块列表 / 底部用户区+退出），无顶栏无首页
 * - 窄屏 = 底部标签栏（同一份 nav 数据、第二渲染器）+「我的」动作单（手机端登出入口）
 * - 管理台入口（#166）：仅 admin 可见（role 来自 /api/me），桌面在用户区、手机在「我的」动作单
 * - 应用密码入口（#168）：仅 mailEnabled（来自 /api/me）可见，位置同用户区/「我的」——成员功能，非管理功能
 * - 会话/模块清单引导在此（骨架/失败卡/空态）；iframe 生命周期归 ModuleHost
 * - 登录未检查完 / 未登录 → 登录页（会话真值在服务端，§6.5）
 */

const instanceName = 'Unself 工作台'

type LoadPhase = 'checking-session' | 'loading-modules' | 'ready' | 'error' | 'empty'
const phase = ref<LoadPhase>('checking-session')
const loadError = ref<ApiError | null>(null)
const modules = ref<RegistryModule[]>([])
const user = ref<{ id: string; name: string; role?: string } | null>(null)

/**
 * 邮件轴能力（#168）：只信 /api/me 的 mailEnabled，未开轴不渲染入口（成员功能，位置同管理台）。
 */
const mailEnabled = ref(false)

/** 当前选中 nav id（'workspace' 或模块 id）。 */
const selectedId = ref('workspace')

/**
 * 模块宿主重挂计数（#306）：点击「已选中的同一个模块」时递增，逼 ModuleHost 重挂
 * iframe 重新走握手。#306 现场：停用→启用后，用户回工作台点 hello——`selectedId`
 * 本来就是 hello（落地即选它），赋值同值不触发 ModuleHost 的 watch，界面卡在上一轮的
 * 失败/握手中，用户「点了没反应」。同 id 再点 = 明确的「再试一次」意图，必须落地为
 * 一次真实重挂（frameKey 变化），而不是 no-op。
 */
const hostReload = ref(0)

/** 导航点击（桌面左栏与窄屏标签栏共用）：同 id 再点 = 对该模块强制重握手。 */
function onModuleNavClick(id: string) {
  if (selectedId.value === id) {
    hostReload.value += 1
    return
  }
  selectedId.value = id
}

/** 手机端「我的」动作单开合（底部标签栏 → 用户名 + 退出）。 */
const sheetOpen = ref(false)
const sheetLayer = ref<HTMLElement | null>(null)
/** #192 F5：动作单 Esc 关闭 + 打开焦点入内 + 关闭焦点回「我的」标签（同一基元，复用面见 use-layer-focus）。 */
const { onKeydown: onSheetKeydown } = useLayerFocus(sheetOpen, () => sheetLayer.value)

/**
 * 管理台入口显隐（#166）：只信 /api/me 的 role，非 admin 完全不渲染。
 * 前端只是视图判断；真值守卫在服务端 /api/admin/* 与 AdminLayout（§6.5 权限真值）。
 */
const isAdmin = computed(() => user.value?.role === 'admin')

/** 管理台首页（#166）：与 AdminLayout 的 /admin → /admin/members 落地一致。 */
const ADMIN_HOME = '/admin/members'

/** 应用密码说明页（#168）：成员自助配置邮件客户端的入口（路由见 router.ts）。 */
const APP_PASSWORD_HOME = '/app-password'

const nav = computed<NavItem[]>(() =>
  buildNav(modules.value.map((m) => ({ id: m.id, enabled: m.enabled, icon: m.manifest?.icon }))),
)

const activeModule = computed(() => {
  if (isHostView(selectedId.value)) return null
  return modules.value.find((m) => m.id === selectedId.value) ?? null
})

/** 非模块格：标签栏固定「我的」入口（§6.5 手机可登出）。 */
const ME_TAB: NavItem = { id: 'me', label: '我的' }
const tabbarItems = computed<NavItem[]>(() => [...nav.value, ME_TAB])

onMounted(async () => {
  // ① 会话真值检查（服务端）：未登录去登录页
  const me = await fetchMe()
  if (!me.authenticated) {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(next)}`)
    return
  }
  user.value = { id: me.user.id, name: me.user.name, role: me.user.role }
  mailEnabled.value = me.mailEnabled

  // ② 拉注册表 + ③ 落地（可重试）
  await loadModules()
})

/** 拉注册表并落地（初始与失败卡重试共用一处，单一实现）。 */
async function loadModules(): Promise<void> {
  phase.value = 'loading-modules'
  loadError.value = null
  try {
    modules.value = await fetchEnabledModules()
  } catch (err) {
    loadError.value = err as ApiError
    phase.value = 'error'
    return
  }
  // ③ 落地规则：直访 / 落第一个启用模块；全部停用空态（§6.5；#83 唯一真值 = lib/landing）
  const enabledIds = modules.value.filter((m) => m.enabled).map((m) => m.id)
  const landingId = landingModuleId(resolveLanding(undefined, enabledIds).path)
  if (isHostView(selectedId.value) && landingId) {
    selectedId.value = landingId
  }
  phase.value = modules.value.length === 0 ? 'empty' : 'ready'
}

/** resolveLanding 产物是站内路径；壳选中态用模块 id，从 /m/<id>/ 契约格式还原。 */
function landingModuleId(path: string): string | null {
  return /^\/m\/([^/]+)\/$/.exec(path)?.[1] ?? null
}

async function onLogout() {
  await logout()
  window.location.assign('/login')
}

function navIcon(item: NavItem) {
  if (item.id === 'workspace') return LayoutDashboard
  return resolveModuleIcon(item.icon)
}

function navInitial(item: NavItem) {
  return moduleInitial(item.id)
}

function onTabClick(item: NavItem) {
  if (item.id === ME_TAB.id) {
    sheetOpen.value = true
    return
  }
  onModuleNavClick(item.id)
}
</script>

<template>
  <div class="shell">
    <!-- 桌面左栏（220px，§6.5）：顶部实例名 / 中部模块列表 / 底部用户区+退出 -->
    <aside class="shell-sidebar">
      <div class="shell-sidebar-header">
        <span class="shell-instance-name">{{ instanceName }}</span>
        <!-- 工作台头部铃铛（#19）：桌面在左栏头部，窄屏切到顶部栏 -->
        <NotificationBell />
      </div>

      <nav class="shell-nav" aria-label="模块导航">
        <button
          v-for="item in nav"
          :key="item.id"
          type="button"
          class="shell-nav-item"
          :class="{ 'shell-nav-item-active': selectedId === item.id }"
          @click="onModuleNavClick(item.id)"
        >
          <component
            :is="navIcon(item)"
            v-if="navIcon(item)"
            :size="16"
            aria-hidden="true"
          />
          <span v-else class="shell-nav-initial" aria-hidden="true">{{ navInitial(item) }}</span>
          <span class="shell-nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <div class="shell-sidebar-footer">
        <!-- 应用密码入口（#168）：仅邮件轴开启时渲染（成员可见，位置同管理台） -->
        <RouterLink v-if="mailEnabled" class="shell-mail-entry" data-test="mail-entry" :to="APP_PASSWORD_HOME">
          <KeyRound :size="16" aria-hidden="true" />
          应用密码
        </RouterLink>
        <!-- 管理台入口（#166）：仅 admin 渲染（非 admin 无此 DOM，不只是视觉隐藏） -->
        <RouterLink v-if="isAdmin" class="shell-admin-entry" data-test="admin-entry" :to="ADMIN_HOME">
          <ShieldCheck :size="16" aria-hidden="true" />
          管理台
        </RouterLink>
        <div class="shell-user-row">
          <div class="shell-user">
            <span class="shell-user-avatar" aria-hidden="true">{{ user?.name?.charAt(0) ?? '?' }}</span>
            <span class="shell-user-name" data-test="user-name">{{ user?.name ?? '…' }}</span>
          </div>
          <button type="button" class="shell-logout" data-test="logout" aria-label="退出登录" @click="onLogout">
            <LogOut :size="16" aria-hidden="true" />
            退出
          </button>
        </div>
      </div>
    </aside>

    <!-- 窄屏顶部栏（#19）：铃铛进顶部栏；桌面隐藏（铃铛在左栏头部） -->
    <header class="shell-topbar">
      <span class="shell-topbar-name">{{ instanceName }}</span>
      <NotificationBell />
    </header>

    <!-- 主区 -->
    <main class="shell-main">
      <!-- 会话/模块清单检查中：骨架屏（§6.5 异常规范） -->
      <div v-if="phase === 'checking-session' || phase === 'loading-modules'" class="shell-center">
        <USkeleton class="shell-skeleton" />
      </div>

      <!-- 清单加载失败卡 -->
      <div v-else-if="phase === 'error' && loadError" class="shell-center">
        <UErrorCard
          class="shell-error-card"
          title="工作台加载失败"
          :message="loadError.message"
          :request-id="loadError.requestId"
          :detail="loadError.detail"
          retry-label="重试"
          @retry="loadModules"
        />
      </div>

      <!-- 全部停用空态（验收 3） -->
      <div v-else-if="phase === 'empty'" class="shell-center">
        <div class="shell-empty-state">
          <p class="shell-empty-title">还没有启用任何模块</p>
          <p class="shell-empty-desc">请联系管理员在实例配置中启用所需模块。</p>
        </div>
      </div>

      <!-- 工作台视图 / 模块宿主 -->
      <template v-else>
        <div v-if="isHostView(selectedId)" class="shell-center">
          <div class="shell-empty-state">
            <p class="shell-empty-title">工作台</p>
            <p class="shell-empty-desc">从左侧选择一个模块开始工作。</p>
          </div>
        </div>

        <ModuleHost v-else :key="`${selectedId}#${hostReload}`" :module="activeModule" />
      </template>
    </main>

    <!-- 窄屏底部标签栏（同一份 nav 数据，第二渲染器，§6.5 双形态） -->
    <nav class="shell-tabbar" aria-label="模块导航（移动端）">
      <button
        v-for="item in tabbarItems"
        :key="item.id"
        type="button"
        class="shell-tab"
        :data-test="item.id === ME_TAB.id ? 'me-tab' : 'module-tab'"
        :class="{ 'shell-tab-active': selectedId === item.id }"
        :aria-current="selectedId === item.id ? 'page' : undefined"
        :aria-haspopup="item.id === ME_TAB.id ? 'dialog' : undefined"
        @click="onTabClick(item)"
      >
        <User v-if="item.id === ME_TAB.id" :size="20" aria-hidden="true" />
        <component :is="navIcon(item)" v-else-if="navIcon(item)" :size="20" aria-hidden="true" />
        <span v-else class="shell-tab-initial" aria-hidden="true">{{ navInitial(item) }}</span>
        <span class="shell-tab-label">{{ item.label }}</span>
      </button>
    </nav>

    <!-- 手机端「我的」动作单：用户名 + 退出（复用 onLogout，#83） -->
    <div v-if="sheetOpen" class="shell-sheet-backdrop" data-test="me-sheet-backdrop" @click="sheetOpen = false">
      <section
        ref="sheetLayer"
        class="shell-sheet"
        data-test="me-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="我的"
        tabindex="-1"
        @keydown="onSheetKeydown"
        @click.stop
      >
        <div class="shell-sheet-handle" aria-hidden="true" />
        <div class="shell-sheet-user">
          <span class="shell-user-avatar" aria-hidden="true">{{ user?.name?.charAt(0) ?? '?' }}</span>
          <span class="shell-sheet-username">{{ user?.name ?? '…' }}</span>
        </div>
        <!-- 应用密码入口（#168）：手机同页可进说明页；点击先收起动作单 -->
        <RouterLink
          v-if="mailEnabled"
          class="shell-sheet-mail"
          :to="APP_PASSWORD_HOME"
          @click="sheetOpen = false"
        >
          <KeyRound :size="16" aria-hidden="true" />
          应用密码
        </RouterLink>
        <!-- 管理台入口（#166）：手机同页可进管理台（SPEC §8）；点击先收起动作单 -->
        <RouterLink
          v-if="isAdmin"
          class="shell-sheet-admin"
          :to="ADMIN_HOME"
          @click="sheetOpen = false"
        >
          <ShieldCheck :size="16" aria-hidden="true" />
          管理台
        </RouterLink>
        <UButton class="shell-sheet-logout" data-test="sheet-logout" @click="onLogout">
          <LogOut :size="16" aria-hidden="true" />
          退出登录
        </UButton>
      </section>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  background: var(--unself-color-bg);
}

/* ---------- 桌面左栏（220px） ---------- */
.shell-sidebar {
  display: flex;
  flex-direction: column;
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--unself-color-border);
  background: var(--unself-color-surface);
}
.shell-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-2);
  height: 56px;
  padding: 0 var(--unself-space-4);
  border-bottom: 1px solid var(--unself-color-border);
}
.shell-instance-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
}

/* 窄屏顶部栏（#19）：仅窄屏显示，高度与 NotificationBell 下拉的 top 偏移一致 */
.shell-topbar {
  display: none;
}
.shell-topbar-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
}
.shell-nav {
  flex: 1;
  overflow-y: auto;
  padding: var(--unself-space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.shell-nav-item {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  width: 100%;
  height: 36px;
  padding: 0 var(--unself-space-3);
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-base);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.shell-nav-item:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.shell-nav-item-active {
  background: var(--unself-color-surface-active);
  color: var(--unself-color-text);
  font-weight: 500;
}
.shell-nav-initial,
.shell-user-avatar,
.shell-tab-initial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: var(--unself-radius-sm);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font-size: var(--unself-font-size-xs);
  font-weight: 600;
}
.shell-nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
  padding: var(--unself-space-3) var(--unself-space-4);
  border-top: 1px solid var(--unself-color-border);
}
.shell-user-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-2);
  min-width: 0;
}

/* 用户区入口（#166 管理台 / #168 应用密码）：行样式与侧栏导航项同族 */
.shell-admin-entry,
.shell-mail-entry {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  height: 32px;
  padding: 0 var(--unself-space-2);
  border-radius: var(--unself-radius-md);
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
  text-decoration: none;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.shell-admin-entry:hover,
.shell-mail-entry:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.shell-admin-entry:focus-visible,
.shell-mail-entry:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.shell-user {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  min-width: 0;
}
.shell-user-avatar {
  border-radius: var(--unself-radius-full);
}
.shell-user-name {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shell-logout {
  display: inline-flex;
  align-items: center;
  gap: var(--unself-space-1);
  /* #75：长用户名挤压 footer 时，退出按钮不得被 flex-shrink 压窄，
     否则「退出」按 CJK min-content 逐字换行变竖排。压力交给用户名省略号。 */
  flex-shrink: 0;
  white-space: nowrap;
  height: 30px;
  padding: 0 var(--unself-space-2);
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-sm);
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.shell-logout:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-danger);
}

/* ---------- 主区 ---------- */
.shell-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--unself-color-bg);
}
.shell-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-6);
}
.shell-error-card {
  max-width: 440px;
}
.shell-empty-state {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.shell-empty-title {
  margin: 0;
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.shell-empty-desc {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}

/* 引导阶段骨架：宽度约束交给壳，线条样式由 USkeleton 提供 */
.shell-skeleton {
  width: min(320px, 80%);
}

/* ---------- 窄屏：底部标签栏（同一份 nav 数据，第二渲染器） ---------- */
.shell-tabbar {
  display: none;
}

@media (max-width: 768px) {
  .shell {
    flex-direction: column;
  }
  .shell-sidebar {
    display: none;
  }
  .shell-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--unself-space-2);
    height: 48px;
    flex-shrink: 0;
    padding: 0 var(--unself-space-4);
    border-bottom: 1px solid var(--unself-color-border);
    background: var(--unself-color-surface);
  }
  .shell-main {
    flex: 1;
  }
  .shell-tabbar {
    display: flex;
    height: 56px;
    flex-shrink: 0;
    border-top: 1px solid var(--unself-color-border);
    background: var(--unself-color-surface);
    overflow-x: auto;
  }
  .shell-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-width: 64px;
    flex: 1;
    border: none;
    background: transparent;
    color: var(--unself-color-text-tertiary);
    font-size: var(--unself-font-size-xs);
    cursor: pointer;
    transition: color var(--unself-duration-fast) var(--unself-ease-out);
  }
  .shell-tab-active {
    color: var(--unself-color-primary);
  }
  .shell-tab-initial {
    width: 18px;
    height: 18px;
  }
}

/* ---------- 手机端「我的」动作单 ---------- */
.shell-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--unself-color-scrim);
}
.shell-sheet {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-4);
  padding: var(--unself-space-2) var(--unself-space-4) var(--unself-space-8);
  background: var(--unself-color-surface);
  border-top: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg) var(--unself-radius-lg) 0 0;
  animation: shell-sheet-in var(--unself-duration-normal) var(--unself-ease-out);
}
.shell-sheet-handle {
  width: 36px;
  height: 4px;
  margin: 0 auto;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-border);
}
.shell-sheet-user {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  padding: var(--unself-space-2);
}
.shell-sheet-username {
  font-size: var(--unself-font-size-base);
  font-weight: 500;
  color: var(--unself-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shell-sheet-admin,
.shell-sheet-mail {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--unself-space-2);
  min-height: var(--unself-touch-target);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface);
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-base);
  text-decoration: none;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.shell-sheet-admin:hover,
.shell-sheet-mail:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.shell-sheet-admin:focus-visible,
.shell-sheet-mail:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.shell-sheet-logout {
  width: 100%;
}
@keyframes shell-sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}
/* 降低动效偏好：动作单瞬切（原先未限幅，随本次改动补齐） */
@media (prefers-reduced-motion: reduce) {
  .shell-sheet {
    animation: none;
  }
}
</style>
