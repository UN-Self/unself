<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'
import type { CalendarEvent } from '../../../src/types'
import type { EditableDraft } from '../lib/validate'
import { toZonedShort } from '../lib/time'

const props = defineProps<{
  actorName?: string
  fields: string[]
  latest?: CalendarEvent | null
  mine?: EditableDraft | null
  showRetry?: boolean
}>()
const emit = defineEmits<{ refresh: []; retry: []; keep: [] }>()

const labels: Record<string, string> = {
  title: '标题',
  description: '描述',
  location: '地点',
  startAt: '开始时间',
  endAt: '结束时间',
  allDay: '全天',
  timezone: '时区',
  status: '状态',
  responseState: '响应状态',
  rrule: '重复规则',
}
function label(field: string): string {
  return labels[field] ?? field
}

const fieldSummary = computed(() =>
  props.fields.length ? `（${props.fields.map(label).join('、')}）` : '（检测到新版本）',
)

const statusLabels: Record<string, string> = {
  confirmed: '正常',
  tentative: '待定',
  cancelled: '取消',
}

/** 时间按最新值的时区显示，缺时区才退回浏览器本地。 */
function formatTime(ms: number): string {
  const tz = props.latest?.timezone
  if (!tz) {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return toZonedShort(ms, tz)
}

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (field === 'startAt' || field === 'endAt') return formatTime(Number(value))
  if (field === 'status') return statusLabels[String(value)] ?? String(value)
  return String(value)
}

function mineValue(field: keyof EditableDraft): unknown {
  return props.mine?.[field] ?? null
}

function latestValue(field: string): unknown {
  if (!props.latest) return null
  return (props.latest as unknown as Record<string, unknown>)[field] ?? null
}

// 只有 409 撞车才有双方完整值；轮询的 changes 只有字段名，不显示对比
const showDiff = computed(() => Boolean(props.mine && props.latest && props.fields.length))
</script>

<template>
  <div class="remote-banner" role="status">
    <div class="banner-main">
      <span class="banner-text">
        此日程已被 {{ actorName ?? '其他人' }} 修改{{ fieldSummary }}
      </span>
      <span class="banner-actions">
        <button type="button" @click="emit('refresh')">刷新成最新</button>
        <button v-if="showRetry" type="button" @click="emit('retry')">用我的重试</button>
        <button type="button" class="ghost" @click="emit('keep')">保留我的修改</button>
      </span>
    </div>
    <table v-if="showDiff" class="diff-table">
      <thead>
        <tr><th>字段</th><th>我填的</th><th>对方改成</th></tr>
      </thead>
      <tbody>
        <tr v-for="field in fields" :key="field">
          <td class="diff-field">{{ label(field) }}</td>
          <td>{{ displayValue(field, mineValue(field as keyof EditableDraft)) }}</td>
          <td>{{ displayValue(field, latestValue(field)) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.remote-banner {
  display: block;
  padding: 10px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--unself-color-warning, #e6a700);
  border-radius: var(--unself-radius-md, 8px);
  background: var(--unself-color-warning-bg, #fff8e1);
  color: var(--unself-color-text, #1a1a1a);
  font-size: var(--unself-font-size-sm, 13px);
}
.banner-main { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
.banner-actions { display: flex; gap: 8px; }
.banner-actions button {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--unself-radius-sm, 6px);
  background: var(--unself-color-primary, #3457d5);
  color: #fff;
  cursor: pointer;
  font: inherit;
}
.banner-actions button.ghost {
  background: transparent;
  color: var(--unself-color-text-secondary, #555);
  border: 1px solid var(--unself-color-border, #ddd);
}
.diff-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
.diff-table th, .diff-table td {
  text-align: left;
  padding: 6px 8px;
  border-top: 1px solid var(--unself-color-border, #ddd);
  vertical-align: top;
  word-break: break-word;
}
.diff-table th { color: var(--unself-color-text-secondary, #666); font-weight: 500; }
.diff-field { color: var(--unself-color-text-secondary, #555); white-space: nowrap; }
</style>
