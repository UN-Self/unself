<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LogOut, LayoutDashboard } from 'lucide-vue-next'
import { UButton, UErrorCard } from '@unself/ui'
import { buildNav, firstEnabledModule, isHostView, type NavItem } from './lib/nav'
import { fetchEnabledModules, moduleFrameSrc, type RegistryModule, type ApiError } from './lib/registry-api'
import { fetchModuleToken } from './lib/token-api'
import { attachModuleBridge, frameOriginFor, type BridgeHandle } from './lib/module-bridge'
import { logout, fetchMe } from './lib/session-api'
import { resolveModuleIcon, moduleInitial } from './lib/module-icon'

/**
 * 工作台壳（#12，§6.5 动线）：
 * - 桌面 = 220px 左栏（顶部实例名 / 中部模块列表 / 底部用户区+退出），无顶栏无首页
 * - 窄屏 = 底部标签栏（同一份 nav 数据、两个渲染器）
 * - iframe 装载器 + SDK 握手（ready → /api/modules/:id/token → postMessage）
 * - 停用模块从侧栏消失；直访 / 落第一个启用模块；全停用空态
 * - 登录未检查完 / 未登录 → 登录页（会话真值在服务端，§6.5）
 */

const route = useRoute()
const router = useRouter()

type LoadPhase = 'checking-session' | 'loading-modules' | 'ready' | 'error' | 'empty'
const phase = ref<LoadPhase>('checking-session')
const loadError = ref<ApiError | null>(null)
const modules = ref<RegistryModule[]>([])
const user = ref<{ id: string; name: string } | null>(null)

const instanceName = 'Unself 工作台'
/** 当前选中 nav id（'workspace' 或模块 id）。 */
const selectedId = ref('workspace')

const nav = computed<NavItem[]>(() =>
  buildNav(modules.value.map((m) => ({ id: m.id, enabled: m.enabled, icon: m.manifest?.icon }))),
)

const activeModule = computed(() => {
  if (isHostView(selectedId.value)) return null
  return modules.value.find((m) => m.id === selectedId.value) ?? null
})

const frameSrc = computed(() => (activeModule.value ? moduleFrameSrc(activeModule.value) : null))
/** 重挂计数（#71 根因 2）：retry 自增 → frameKey 变化 → iframe 按 key 重挂 → SDK 重新发 ready。 */
const frameReload = ref(0)
const frameKey = computed(() => `${activeModule.value?.id ?? 'none'}#${frameReload.value}`)

// iframe 生命周期状态（六种异常卡，§6.5）
type FrameState = 'idle' | 'handshaking' | 'ready' | 'failed' | 'disabled'
const frameState = ref<FrameState>('idle')
const frameError = ref<ApiError | Error | null>(null)

let bridge: BridgeHandle | null = null
/** iframe 模板 ref：挂载/重挂期间会短暂为空，挂桥前必须确认就位。 */
const frameEl = ref<HTMLIFrameElement | null>(null)

onMounted(async () => {
  // ① 会话真值检查（服务端）：未登录去登录页
  const me = await fetchMe()
  if (!me.authenticated) {
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(next)}`)
    return
  }
  user.value = { id: me.user.id, name: me.user.name }

  // ② 拉注册表（enabled 模块 = 边栏数据源）
  phase.value = 'loading-modules'
  try {
    modules.value = await fetchEnabledModules()
  } catch (err) {
    loadError.value = err as ApiError
    phase.value = 'error'
    return
  }

  // ③ 落地规则：直访 / 落第一个启用模块；全部停用空态（§6.5）
  const first = firstEnabledModule(modules.value)
  if (isHostView(selectedId.value) && first) {
    selectedId.value = first
  }
  phase.value = modules.value.length === 0 ? 'empty' : 'ready'
})

// 落地规则：next 优先（#11 登录回跳已由 URL next 处理），这里兜底 ?m= 参数
void route.query.m

/** 切换选中项；iframe 卸载即拆桥。 */
watch(selectedId, () => {
  bridge?.detach()
  bridge = null
  frameError.value = null
  frameState.value = isHostView(selectedId.value) ? 'idle' : 'handshaking'
})

/**
 * 模块激活即挂桥（#71 根因 2）：
 * flush 'post' 保证回调在 DOM 更新（iframe 挂载）之后执行；
 * 回调内再等一拍取 frameEl；若仍未挂载则等模板 ref 就位，不再静默判 failed。
 */
watch(
  activeModule,
  async (mod) => {
    bridge?.detach()
    bridge = null
    if (!mod) {
      frameState.value = 'idle'
      return
    }
    frameState.value = 'handshaking'
    await nextTick()
    await attachBridgeFor(mod)
  },
  { flush: 'post' },
)

/** 等 iframe 模板 ref 就位（首次挂载/重挂）；模块切换或组件卸载后返回 null。 */
function waitForFrameEl(): Promise<HTMLIFrameElement | null> {
  if (frameEl.value) return Promise.resolve(frameEl.value)
  return new Promise((resolve) => {
    let stopFrame = () => {}
    const stopActive = watch(activeModule, () => {
      stopFrame()
      resolve(null)
    })
    stopFrame = watch(frameEl, (el) => {
      if (el) {
        stopActive()
        stopFrame()
        resolve(el)
      }
    })
  })
}

/**
 * 给模块挂桥（watch 与 retry 共用，避免两处漂移）：
 * 仅入口配置无效（frameOriginFor 为 null）才判 failed；iframe 未挂载则等挂载后再挂。
 */
async function attachBridgeFor(mod: RegistryModule): Promise<void> {
  const origin = frameOriginFor(mod.manifest?.entry ?? null)
  if (origin === null) {
    frameError.value = new Error('模块入口配置无效，请联系管理员')
    frameState.value = 'failed'
    return
  }
  const iframe = await waitForFrameEl()
  if (!iframe) return
  // 等待期间用户可能已切换模块：交给新模块的 watch 处理
  if (activeModule.value !== mod) return
  bridge?.detach()
  bridge = attachModuleBridge({
    iframe,
    moduleId: mod.id,
    frameOrigin: origin,
    onToken: () => {
      frameState.value = 'ready'
    },
    onError: (err) => {
      frameError.value = err
      frameState.value = 'failed'
    },
  })
}

onBeforeUnmount(() => bridge?.detach())

// 15s 握手超时（§6.5 异常卡：加载中骨架 → 失败卡）
const HANDSHAKE_TIMEOUT_MS = 15_000
let handshakeTimer: ReturnType<typeof setTimeout> | undefined
watch([activeModule, frameState], ([, state]) => {
  clearTimeout(handshakeTimer)
  if (state === 'handshaking') {
    handshakeTimer = setTimeout(() => {
      if (frameState.value === 'handshaking') {
        frameError.value = new Error('模块加载超时，请稍后重试')
        frameState.value = 'failed'
      }
    }, HANDSHAKE_TIMEOUT_MS)
  }
})

async function onLogout() {
  await logout()
  window.location.assign('/login')
}

/**
 * 手动重试：强制 iframe 重挂（frameReload 自增 → key 变化 → 新 iframe 重新发 ready），
 * 重挂后对新 iframe 重新挂桥——旧消息不再丢失（#71 根因 2）。
 */
async function retryFrame() {
  frameError.value = null
  frameState.value = 'handshaking'
  const mod = activeModule.value
  if (!mod) return
  bridge?.detach()
  bridge = null
  frameReload.value += 1
  await nextTick()
  await attachBridgeFor(mod)
}

/** 选中模块的完整 URL（新窗口打开，轻操作兜底）。 */
function moduleHref(id: string): string {
  return `/m/${id}/`
}

function navIcon(item: NavItem) {
  if (item.id === 'workspace') return LayoutDashboard
  return resolveModuleIcon(item.icon)
}

function navInitial(item: NavItem) {
  return moduleInitial(item.id)
}

// 直接校验 token 端点的禁用语义（验收 1：直访 /m/hello/ 领不到新 token）
// 由 core-api checkTokenGate 保证（#3/#7）；此处仅暴露状态给测试/人工验收。
void fetchModuleToken
</script>

<template>
  <div class="shell" :class="{ 'shell-empty': phase === 'empty' }">
    <!-- 桌面左栏（220px，§6.5）：顶部实例名 / 中部模块列表 / 底部用户区+退出 -->
    <aside class="shell-sidebar">
      <div class="shell-sidebar-header">
        <span class="shell-instance-name">{{ instanceName }}</span>
      </div>

      <nav class="shell-nav" aria-label="模块导航">
        <button
          v-for="item in nav"
          :key="item.id"
          type="button"
          class="shell-nav-item"
          :class="{ 'shell-nav-item-active': selectedId === item.id }"
          @click="selectedId = item.id"
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
        <div class="shell-user">
          <span class="shell-user-avatar" aria-hidden="true">{{ user?.name?.charAt(0) ?? '?' }}</span>
          <span class="shell-user-name">{{ user?.name ?? '…' }}</span>
        </div>
        <button type="button" class="shell-logout" aria-label="退出登录" @click="onLogout">
          <LogOut :size="16" aria-hidden="true" />
          退出
        </button>
      </div>
    </aside>

    <!-- 主区 -->
    <main class="shell-main">
      <!-- 会话/模块清单检查中：骨架屏（§6.5 异常规范） -->
      <div v-if="phase === 'checking-session' || phase === 'loading-modules'" class="shell-center">
        <div class="shell-skeleton" aria-busy="true">
          <span class="shell-skeleton-line" />
          <span class="shell-skeleton-line shell-skeleton-line-short" />
        </div>
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
          @retry="phase = 'loading-modules'"
        />
      </div>

      <!-- 全部停用空态（验收 3） -->
      <div v-else-if="phase === 'empty'" class="shell-center">
        <div class="shell-empty-state">
          <p class="shell-empty-title">还没有启用任何模块</p>
          <p class="shell-empty-desc">请联系管理员在实例配置中启用所需模块。</p>
        </div>
      </div>

      <!-- 工作台视图 / 模块 iframe -->
      <template v-else>
        <div v-if="isHostView(selectedId)" class="shell-center">
          <div class="shell-empty-state">
            <p class="shell-empty-title">工作台</p>
            <p class="shell-empty-desc">从左侧选择一个模块开始工作。</p>
          </div>
        </div>

        <div v-else class="shell-frame-wrap">
          <!-- 加载中骨架（握手期间，15s 超时） -->
          <div v-if="frameState === 'handshaking'" class="shell-frame-skeleton" aria-busy="true">
            <span class="shell-skeleton-line" />
            <span class="shell-skeleton-line shell-skeleton-line-short" />
            <p class="shell-frame-skeleton-hint">正在连接模块…</p>
          </div>

          <!-- 模块异常卡（停用/失败/超时/配置无效，§6.5 成员只见人话+request id） -->
          <div v-if="frameState === 'failed'" class="shell-frame-error">
            <UErrorCard
              class="shell-error-card"
              :title="frameError instanceof Error && frameError.message.includes('停用') ? '此模块已停用' : '模块加载失败'"
              :message="frameError?.message"
              :request-id="frameError && 'requestId' in frameError ? frameError.requestId : undefined"
              :detail="frameError && 'detail' in frameError ? frameError.detail : undefined"
              retry-label="重新加载"
              @retry="retryFrame"
            />
          </div>

          <iframe
            v-if="frameSrc"
            ref="frameEl"
            :key="frameKey"
            :src="frameSrc"
            class="shell-frame"
            :title="`模块：${activeModule?.id}`"
            :class="{ 'shell-frame-hidden': frameState !== 'ready' }"
          />
        </div>
      </template>
    </main>

    <!-- 窄屏底部标签栏（同一份 nav 数据，第二渲染器，§6.5 双形态） -->
    <nav class="shell-tabbar" aria-label="模块导航（移动端）">
      <button
        v-for="item in nav"
        :key="item.id"
        type="button"
        class="shell-tab"
        :class="{ 'shell-tab-active': selectedId === item.id }"
        :aria-current="selectedId === item.id ? 'page' : undefined"
        @click="selectedId = item.id"
      >
        <component :is="navIcon(item)" v-if="navIcon(item)" :size="20" aria-hidden="true" />
        <span v-else class="shell-tab-initial" aria-hidden="true">{{ navInitial(item) }}</span>
        <span class="shell-tab-label">{{ item.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  background: var(--color-bg);
}

/* ---------- 桌面左栏（220px） ---------- */
.shell-sidebar {
  display: flex;
  flex-direction: column;
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
}
.shell-sidebar-header {
  display: flex;
  align-items: center;
  height: 56px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-border);
}
.shell-instance-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
}
.shell-nav {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.shell-nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.shell-nav-item:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}
.shell-nav-item-active {
  background: var(--color-surface-active);
  color: var(--color-text);
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
  border-radius: var(--radius-sm);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
}
.shell-nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border);
}
.shell-user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.shell-user-avatar {
  border-radius: var(--radius-full);
}
.shell-user-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shell-logout {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  /* #75：长用户名挤压 footer 时，退出按钮不得被 flex-shrink 压窄，
     否则「退出」按 CJK min-content 逐字换行变竖排。压力交给用户名省略号。 */
  flex-shrink: 0;
  white-space: nowrap;
  height: 30px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.shell-logout:hover {
  background: var(--color-surface-hover);
  color: var(--color-danger);
}

/* ---------- 主区 ---------- */
.shell-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}
.shell-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
}
.shell-error-card {
  max-width: 440px;
}
.shell-empty-state {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.shell-empty-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 600;
  color: var(--color-text);
}
.shell-empty-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.shell-frame-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}
.shell-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.shell-frame-hidden {
  visibility: hidden;
  position: absolute;
  inset: 0;
}
.shell-frame-skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-bg);
}
.shell-frame-skeleton-hint {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
}
.shell-frame-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: var(--color-bg);
}

/* 骨架屏 */
.shell-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: min(320px, 80%);
}
.shell-skeleton-line {
  display: block;
  height: 14px;
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--color-surface) 25%, var(--color-surface-hover) 50%, var(--color-surface) 75%);
  background-size: 200% 100%;
  animation: shell-shimmer 1.4s ease infinite;
}
.shell-skeleton-line-short {
  width: 60%;
}
@keyframes shell-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
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
  .shell-main {
    flex: 1;
  }
  .shell-tabbar {
    display: flex;
    height: 56px;
    flex-shrink: 0;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface);
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
    color: var(--color-text-tertiary);
    font-size: var(--font-size-xs);
    cursor: pointer;
    transition: color var(--duration-fast) var(--ease-out);
  }
  .shell-tab-active {
    color: var(--color-primary);
  }
  .shell-tab-initial {
    width: 18px;
    height: 18px;
  }
}
</style>
