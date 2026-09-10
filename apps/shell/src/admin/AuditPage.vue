<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { UErrorCard, USkeleton } from '@unself/ui'

import { fetchAuditLog, type ApiError, type AuditEntry } from '../lib/admin-api'

/**
 * 管理台审计页（#17）：倒序只读列表，服务端一次给最新 200 条。
 * 不做：筛选、搜索、导出、分页。
 */

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref<ApiError | null>(null)
const entries = ref<AuditEntry[]>([])

onMounted(load)

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    entries.value = await fetchAuditLog()
    phase.value = 'ready'
  } catch (err) {
    loadError.value = err as ApiError
    phase.value = 'error'
  }
}
</script>

<template>
  <div>
    <h1 class="page-title">审计</h1>

    <USkeleton v-if="phase === 'loading'" class="page-skeleton" />

    <UErrorCard
      v-else-if="phase === 'error'"
      title="审计记录加载失败"
      :message="loadError?.message"
      :request-id="loadError?.requestId"
      :detail="loadError?.detail"
    />

    <template v-else>
      <p v-if="entries.length === 0" class="page-empty">还没有审计记录</p>

      <div v-else class="audit-list">
        <div v-for="entry in entries" :key="entry.id" class="audit-row">
          <span class="audit-time">{{ entry.created_at }}</span>
          <span class="audit-action">{{ entry.action }}</span>
          <span class="audit-actor">{{ entry.actor }}</span>
          <span v-if="entry.target" class="audit-target">{{ entry.target }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
@import './page.css';

.audit-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
}
.audit-row {
  display: flex;
  align-items: center;
  gap: var(--unself-space-4);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-bottom: 1px solid var(--unself-color-border);
  font-size: var(--unself-font-size-sm);
}
.audit-row:last-child {
  border-bottom: none;
}
.audit-time {
  flex-shrink: 0;
  color: var(--unself-color-text-tertiary);
  font-variant-numeric: tabular-nums;
  font-size: var(--unself-font-size-xs);
}
.audit-action {
  font-weight: 500;
  color: var(--unself-color-text);
}
.audit-actor,
.audit-target {
  color: var(--unself-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audit-target {
  margin-left: auto;
  font-size: var(--unself-font-size-xs);
}
</style>
