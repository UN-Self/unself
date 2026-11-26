<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { CalendarEvent, EventStatus } from '../../../src/types'
import { ApiError, AuthExpiredError, patchEvent, VersionConflictError, type EventPatch } from '../lib/api'
import { describeApiError, diffEditableFields, validateDraft } from '../lib/validate'
import { fromZonedInput, toZonedInput } from '../lib/time'

const props = defineProps<{ event: CalendarEvent }>()
const emit = defineEmits<{
  saved: [event: CalendarEvent]
  conflict: [payload: { latest: CalendarEvent; actorName: string | null; fields: string[]; patch: EventPatch; draft: Draft }]
  'auth-expired': []
}>()

type Draft = {
  title: string
  description: string
  location: string
  startAt: number
  endAt: number
  status: EventStatus
}

/** 时间一律按日程自己的时区渲染与回写，不跟浏览器时区。 */
function toInput(ms: number): string {
  return toZonedInput(ms, props.event.timezone)
}
function fromInput(s: string): number {
  return fromZonedInput(s, props.event.timezone)
}

const title = ref(props.event.title)
const description = ref(props.event.description ?? '')
const location = ref(props.event.location ?? '')
const startLocal = ref(toInput(props.event.startAt))
const endLocal = ref(toInput(props.event.endAt))
const status = ref<EventStatus>(props.event.status)

const error = ref('')
const saved = ref(false)
const saving = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined

function flashSaved(): void {
  saved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { saved.value = false }, 2000)
}

onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer)
})

// 回流只覆盖字段，不清 saved；绿字统一由 flashSaved 的 2 秒定时器熄灭
watch(() => props.event, (e) => {
  title.value = e.title
  description.value = e.description ?? ''
  location.value = e.location ?? ''
  startLocal.value = toZonedInput(e.startAt, e.timezone)
  endLocal.value = toZonedInput(e.endAt, e.timezone)
  status.value = e.status
})

const statusOptions: EventStatus[] = ['confirmed', 'tentative', 'cancelled']

async function onSave(): Promise<void> {
  error.value = ''
  saved.value = false
  if (savedTimer) clearTimeout(savedTimer)

  const draft = {
    title: title.value.trim(),
    description: description.value,
    location: location.value,
    startAt: fromInput(startLocal.value),
    endAt: fromInput(endLocal.value),
    status: status.value,
  }
  const invalid = validateDraft(draft)
  if (invalid) { error.value = invalid; return }

  const patch: EventPatch = {
    title: draft.title,
    description: draft.description || null,
    location: draft.location || null,
    startAt: draft.startAt,
    endAt: draft.endAt,
    status: draft.status,
    version: props.event.version,
  }

  saving.value = true
  try {
    const updated = await patchEvent(props.event.id, patch)
    flashSaved()
    // 把服务端的 version 写回本地状态，下次保存带新的，避免旧 patch 白白撞 409
    emit('saved', updated)
  } catch (err) {
    if (err instanceof VersionConflictError) {
      emit('conflict', {
        latest: err.event,
        actorName: err.actorName,
        fields: diffEditableFields(draft, err.event),
        // 留住提交前这份 patch，供「用我的重试」拿新 version 再发一次
        patch,
        draft,
      })
    } else if (err instanceof AuthExpiredError) {
      emit('auth-expired')
    } else if (err instanceof ApiError) {
      error.value = describeApiError(err.code, err.field)
    } else {
      error.value = '保存失败，请稍后再试'
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="editor">
    <p class="tz-hint">时间按日程时区 {{ event.timezone }} 显示和保存</p>
    <label class="field">
      <span>标题</span>
      <input v-model="title" type="text" maxlength="200" />
    </label>
    <label class="field">
      <span>描述</span>
      <textarea v-model="description" rows="3"></textarea>
    </label>
    <label class="field">
      <span>开始时间</span>
      <input v-model="startLocal" type="datetime-local" />
    </label>
    <label class="field">
      <span>结束时间</span>
      <input v-model="endLocal" type="datetime-local" />
    </label>
    <label class="field">
      <span>地点</span>
      <input v-model="location" type="text" />
    </label>
    <label class="field">
      <span>状态</span>
      <select v-model="status">
        <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
      </select>
    </label>
    <p v-if="error" class="msg err">{{ error }}</p>
    <p v-if="saved" class="msg ok">已保存</p>
    <div class="actions">
      <button type="button" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.editor { background: var(--unself-color-surface, #fff); border: 1px solid var(--unself-color-border, #ddd); border-radius: var(--unself-radius-lg, 12px); padding: 20px; }
.tz-hint { font-size: var(--unself-font-size-sm, 13px); color: var(--unself-color-text-secondary, #666); margin: 0 0 14px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: var(--unself-font-size-sm, 13px); color: var(--unself-color-text-secondary, #555); }
.field input, .field textarea, .field select { padding: 8px 10px; border: 1px solid var(--unself-color-border, #ddd); border-radius: var(--unself-radius-md, 8px); font: inherit; color: var(--unself-color-text, #1a1a1a); background: var(--unself-color-bg, #fff); }
.msg { font-size: var(--unself-font-size-sm, 13px); margin: 0 0 10px; }
.err { color: var(--unself-color-danger, #c0392b); }
.ok { color: var(--unself-color-success, #1f8b4c); }
.actions { display: flex; justify-content: flex-end; }
.actions button { padding: 8px 18px; border: 0; border-radius: var(--unself-radius-md, 8px); background: var(--unself-color-primary, #3457d5); color: #fff; cursor: pointer; }
.actions button:disabled { opacity: 0.6; cursor: default; }
</style>
