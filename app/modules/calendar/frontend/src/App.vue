<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import EventEditor from './components/EventEditor.vue'
import RemoteEditBanner from './components/RemoteEditBanner.vue'
import type { CalendarEvent, EventChange } from '../../src/types'
import {
  AuthExpiredError,
  fetchEvent,
  mockSimulateRemoteEdit,
  patchEvent,
  setTokenProvider,
  VersionConflictError,
  type EventPatch,
} from './lib/api'
import { MODE_LOCKED, isMock, mode } from './lib/mode'
import { createCalendarSession } from './lib/session'
import { useEventChanges } from './lib/use-event-changes'
import { diffEditableFields, type EditableDraft } from './lib/validate'

const EVENT_ID = 'demo-1'

const event = ref<CalendarEvent | null>(null)
const loadError = ref('')
const authExpired = ref(false)
const handshakeError = ref('')
const handshakeReady = ref(false)
const banner = ref<{
  actorName: string
  fields: string[]
  latest: CalendarEvent | null
  retry: { patch: EventPatch; draft: EditableDraft } | null
} | null>(null)

// 会话先建、先握手：壳（或 dev-shim）下发 token 后才加载日程
const session = createCalendarSession()
setTokenProvider(() => session.getToken())

async function bootstrap(): Promise<void> {
  try {
    // 没写环境变量时先试握手：成则真接口，壳不在则回落 mock
    if (!isMock() || MODE_LOCKED === null) {
      try {
        await session.handshake(1500)
        mode.value = 'live'
      } catch (err) {
        if (MODE_LOCKED === 'live') throw err
      }
    }
    handshakeReady.value = true
    await load()
  } catch (err) {
    handshakeError.value = err instanceof Error ? err.message : String(err)
  }
}

onBeforeUnmount(() => session.dispose())

async function load(): Promise<void> {
  try {
    event.value = await fetchEvent(EVENT_ID)
    loadError.value = ''
  } catch {
    loadError.value = '加载日程失败'
  }
}
void bootstrap()

function onRemoteChange(change: EventChange): void {
  // 轮询提前提示：changes 里没有完整 event，刷新时走 GET；这种横幅不提供重试
  banner.value = { actorName: change.actorName, fields: change.changedFields, latest: null, retry: null }
}

const { pendingCount } = useEventChanges({
  eventId: EVENT_ID,
  // 把当前表单的版本号交给轮询，用来过滤自己刚保存产生的变更
  getVersion: () => event.value?.version ?? 0,
  onHit: onRemoteChange,
  onAuthExpired: () => { authExpired.value = true },
})

function onSaved(updated: CalendarEvent): void {
  // version 写回本地：下次保存带新的，避免拿新版本配旧 patch
  event.value = updated
}

/** 保存撞到 409：用返回的最新值弹对比横幅，不自动覆盖。 */
function onConflict(payload: {
  latest: CalendarEvent
  actorName?: string | null
  fields: string[]
  patch: EventPatch
  draft: EditableDraft
}): void {
  banner.value = {
    actorName: payload.actorName ?? '其他人',
    fields: payload.fields,
    latest: payload.latest,
    retry: { patch: payload.patch, draft: payload.draft },
  }
}

/** 用我的重试：拿 409 返回的 version 重新提交同一份 patch。 */
async function onRetry(): Promise<void> {
  if (!banner.value?.retry) return
  const { patch, draft } = banner.value.retry
  const version = banner.value.latest?.version ?? patch.version
  try {
    const updated = await patchEvent(EVENT_ID, { ...patch, version })
    event.value = updated
    banner.value = null
  } catch (err) {
    if (err instanceof VersionConflictError) {
      // 又撞车：更新对比值，继续让用户选
      banner.value = {
        actorName: err.actorName ?? '其他人',
        fields: diffEditableFields(draft, err.event),
        latest: err.event,
        retry: { patch, draft },
      }
    } else if (err instanceof AuthExpiredError) {
      authExpired.value = true
    } else {
      loadError.value = '重试失败，请稍后再试'
    }
  }
}

async function refreshLatest(): Promise<void> {
  if (!banner.value) return
  if (banner.value.latest) event.value = banner.value.latest
  else await load()
  banner.value = null
}

function keepMine(): void {
  banner.value = null
}

/** 演示按钮：模拟另一个人保存了一条变更，3 秒内触发黄条。 */
function simulateRemote(): void {
  mockSimulateRemoteEdit(['title', 'location'])
}
</script>

<template>
  <main class="page">
    <h1 class="page-title">日历 · 编辑日程</h1>
    <p class="page-note">{{ isMock() ? 'mock 演示：保存走假接口，撞车弹对比横幅。' : '真接口模式：数据读写走模块后端。' }}</p>

    <p v-if="handshakeError" class="msg err">{{ handshakeError }}</p>
    <p v-if="!handshakeReady && !handshakeError" class="msg">正在连接平台…</p>
    <p v-if="authExpired" class="msg err">登录已过期，请重新登录。</p>
    <p v-if="loadError" class="msg err">{{ loadError }}</p>

    <p v-if="pendingCount > 0" class="msg">另有 {{ pendingCount }} 条日程有更新</p>
    <RemoteEditBanner
      v-if="banner && event"
      :actor-name="banner.actorName"
      :fields="banner.fields"
      :latest="banner.latest"
      :mine="banner.retry?.draft ?? null"
      :show-retry="banner.retry !== null"
      @refresh="refreshLatest"
      @retry="onRetry"
      @keep="keepMine"
    />

    <EventEditor
      v-if="event"
      :event="event"
      @saved="onSaved"
      @conflict="onConflict"
      @auth-expired="authExpired = true"
    />

    <div v-if="isMock()" class="demo-tools">
      <button type="button" @click="simulateRemote">模拟别人改了这条（看黄条）</button>
    </div>
  </main>
</template>

<style scoped>
.page { max-width: 560px; margin: 40px auto; padding: 0 20px; font-family: var(--unself-font-family, system-ui); }
.page-title { font-size: var(--unself-font-size-xl, 20px); color: var(--unself-color-text, #1a1a1a); }
.page-note { font-size: var(--unself-font-size-sm, 13px); color: var(--unself-color-text-secondary, #666); }
.msg { font-size: var(--unself-font-size-sm, 13px); }
.err { color: var(--unself-color-danger, #c0392b); }
.demo-tools { margin-top: 16px; }
.demo-tools button {
  padding: 6px 12px;
  font: inherit;
  font-size: var(--unself-font-size-sm, 13px);
  border: 1px dashed var(--unself-color-border, #ccc);
  border-radius: var(--unself-radius-md, 8px);
  background: transparent;
  color: var(--unself-color-text-secondary, #555);
  cursor: pointer;
}
</style>
