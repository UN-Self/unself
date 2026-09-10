<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { UButton, UErrorCard, USkeleton } from '@unself/ui'

import { fetchAdminModules, toggleModule, type AdminModule, type ApiError } from '../lib/admin-api'

/**
 * 管理台模块页（#17）：全量列表（含停用）+ 启停开关。
 * 停用中的模块也显示（#77 部署器遗留诉求的界面闭环）。
 * 不做：模块详情、配置、排序拖拽。
 */

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref<ApiError | null>(null)
const modules = ref<AdminModule[]>([])
const busyId = ref<string | null>(null)
const actionError = ref<string | null>(null)

onMounted(load)

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    modules.value = await fetchAdminModules()
    phase.value = 'ready'
  } catch (err) {
    loadError.value = err as ApiError
    phase.value = 'error'
  }
}

/** 启停直接生效（注册表开关秒级可见；无 confirm——动作可逆）。 */
async function onToggle(mod: AdminModule): Promise<void> {
  busyId.value = mod.id
  actionError.value = null
  try {
    await toggleModule(mod.id, !mod.enabled)
    mod.enabled = !mod.enabled
  } catch (err) {
    actionError.value = (err as ApiError).message
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div>
    <h1 class="page-title">模块</h1>

    <USkeleton v-if="phase === 'loading'" class="page-skeleton" />

    <UErrorCard
      v-else-if="phase === 'error'"
      title="模块列表加载失败"
      :message="loadError?.message"
      :request-id="loadError?.requestId"
      :detail="loadError?.detail"
    />

    <div v-else class="module-list">
      <p v-if="actionError" class="form-alert" role="alert">{{ actionError }}</p>

      <p v-if="modules.length === 0" class="page-empty">还没有注册模块（部署脚本装配后出现在这里）</p>

      <div v-for="mod in modules" :key="mod.id" class="module-row">
        <div class="module-id">
          {{ mod.id }}
          <span v-if="mod.version" class="module-version">v{{ mod.version }}</span>
        </div>
        <span class="badge" :class="mod.enabled ? 'badge-ok' : 'badge-muted'">
          {{ mod.enabled ? '启用中' : '已停用' }}
        </span>
        <UButton
          :variant="mod.enabled ? 'outline' : 'primary'"
          size="sm"
          :disabled="busyId !== null"
          @click="onToggle(mod)"
        >
          {{ mod.enabled ? '停用' : '启用' }}
        </UButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import './page.css';

.module-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.module-row {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-3) var(--unself-space-4);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-bg);
}
.module-id {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.module-version {
  margin-left: var(--unself-space-2);
  font-size: var(--unself-font-size-xs);
  font-weight: 400;
  color: var(--unself-color-text-tertiary);
}
</style>
