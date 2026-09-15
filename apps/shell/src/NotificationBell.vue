<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Bell } from 'lucide-vue-next'

import type { NotificationItem } from './lib/notification-api'
import { useNotifications } from './lib/use-notifications'

/**
 * 工作台通知铃铛（#19）：未读徽章 + 下拉最近 10 条。
 * - 进工作台 ensureLoaded 一次 + 打开下拉 refresh；点击未读项点击即读（面板保持打开）
 * - 克制口径：无轮询、无实时推送、无批量已读、无通知偏好
 * - 类型中文名来自服务端 typeLabel，前端不硬编码类型名映射；摘要只认 payload 契约字段
 * - 桌面左栏与窄屏顶栏两个挂载点共享 use-notifications 单例，不重复拉取
 */

const PANEL_LIMIT = 10

const { items, unreadCount, error, ensureLoaded, refresh, markRead } = useNotifications()

const open = ref(false)

onMounted(() => {
  void ensureLoaded()
})

async function togglePanel(): Promise<void> {
  if (open.value) {
    open.value = false
    return
  }
  open.value = true
  await refresh()
}

/** 面板行：最近 10 条（服务端已倒序）+ 契约摘要。 */
const rows = computed(() =>
  items.value.slice(0, PANEL_LIMIT).map((item) => ({ item, summary: summarize(item) })),
)

/** payload 摘要：缺字段/非对象 → ''（只显示服务端类型名）。 */
function summarize(item: NotificationItem): string {
  const payload = item.payload
  if (typeof payload !== 'object' || payload === null) return ''
  const p = payload as Record<string, unknown>
  if (item.type === 'module_toggled') {
    const name = p.moduleName ?? p.moduleId
    if (typeof name !== 'string' || typeof p.enabled !== 'boolean') return ''
    return `「${name}」${p.enabled ? '已启用' : '已停用'}`
  }
  if (item.type === 'invite_result') {
    if (typeof p.approved !== 'boolean') return ''
    return p.approved ? '加入申请已通过' : '加入申请未通过'
  }
  if (item.type === 'account_ready') {
    if (typeof p.email !== 'string') return ''
    return `${p.email} 已开通`
  }
  return ''
}
</script>

<template>
  <div class="notification-bell">
    <button
      type="button"
      class="notification-bell-trigger"
      aria-label="通知"
      aria-haspopup="true"
      :aria-expanded="open"
      @click="togglePanel"
    >
      <Bell :size="18" aria-hidden="true" />
      <span v-if="unreadCount > 0" class="notification-bell-badge">{{ unreadCount }}</span>
    </button>

    <!-- 点击外部关闭的透明接收层（下拉不做模态遮罩，不压暗工作台） -->
    <div v-if="open" class="notification-bell-backdrop" @click="open = false" />

    <section v-if="open" class="notification-bell-panel" aria-label="通知列表" @click.stop>
      <p
        v-if="error"
        class="notification-bell-status notification-bell-status-error"
      >
        {{ error }}
      </p>
      <p v-else-if="rows.length === 0" class="notification-bell-status">暂无通知</p>

      <template v-else>
        <button
          v-for="row in rows"
          :key="row.item.id"
          type="button"
          class="notification-bell-item"
          :class="{ 'notification-bell-item-unread': !row.item.isRead }"
          @click="markRead(row.item.id)"
        >
          <span class="notification-bell-item-head">
            <span v-if="!row.item.isRead" class="notification-bell-dot" aria-hidden="true" />
            <span class="notification-bell-type">{{ row.item.typeLabel }}</span>
          </span>
          <span v-if="row.summary" class="notification-bell-summary">{{ row.summary }}</span>
          <span class="notification-bell-time">{{ row.item.createdAt }}</span>
        </button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.notification-bell {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.notification-bell-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-secondary);
  cursor: pointer;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out);
}
.notification-bell-trigger:hover {
  background: var(--unself-color-surface-hover);
  color: var(--unself-color-text);
}
.notification-bell-trigger:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}

.notification-bell-badge {
  position: absolute;
  top: calc(-1 * var(--unself-space-1));
  right: calc(-1 * var(--unself-space-1));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 var(--unself-space-1);
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-danger);
  color: var(--unself-color-bg);
  font-size: var(--unself-font-size-xs);
  font-weight: 600;
  line-height: 1;
}

.notification-bell-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: transparent;
}

.notification-bell-panel {
  position: absolute;
  top: calc(100% + var(--unself-space-2));
  /* 锚点用 left：桌面铃铛在 220px 左栏右侧，right 锚会把面板向左推出屏外；
     窄屏媒体查询改 fixed 全宽，不受此影响 */
  left: 0;
  z-index: 41;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  width: 320px;
  max-width: calc(100vw - var(--unself-space-4));
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--unself-space-2);
  background: var(--unself-color-bg);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  box-shadow: var(--unself-shadow-pop);
}

.notification-bell-status {
  margin: 0;
  padding: var(--unself-space-4) var(--unself-space-3);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
  text-align: center;
}
.notification-bell-status-error {
  color: var(--unself-color-danger);
}

.notification-bell-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--unself-space-1);
  width: 100%;
  padding: var(--unself-space-2) var(--unself-space-3);
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--unself-duration-fast) var(--unself-ease-out);
}
.notification-bell-item:hover {
  background: var(--unself-color-surface-hover);
}
.notification-bell-item:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: -2px;
}

.notification-bell-item-head {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.notification-bell-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: var(--unself-radius-full);
  background: var(--unself-color-primary);
}
.notification-bell-type {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
/* 未读：主色圆点 + 文字更重；已读：次级文字、无圆点 */
.notification-bell-item-unread .notification-bell-type {
  color: var(--unself-color-text);
  font-weight: 600;
}
.notification-bell-summary {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-secondary);
}
.notification-bell-time {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}

/* 窄屏：下拉全宽挂在顶栏下方（与 App.vue .shell-topbar 高度 48px 对齐） */
@media (max-width: 768px) {
  .notification-bell-panel {
    position: fixed;
    top: 48px;
    left: 0;
    right: 0;
    width: auto;
    max-width: none;
    border-radius: 0;
  }
}
</style>
