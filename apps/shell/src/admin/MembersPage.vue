<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Ban, CircleCheck } from 'lucide-vue-next'

import { UButton, UErrorCard, USkeleton } from '@unself/ui'

import { fetchMembers, setMemberStatus, type AdminMember, type ApiError } from '../lib/admin-api'

/**
 * 管理台成员页（#17）：全量列表 + 停用/启用。
 * 不做：编辑、删除、搜索、分页、批量（M1 范围外）。
 */

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref<ApiError | null>(null)
const members = ref<AdminMember[]>([])
/** 正在翻转状态的成员 id（按钮禁用防连点）。 */
const busyId = ref<string | null>(null)
/** 动作失败的人话提示（行内展示；列表加载失败才用错误卡）。 */
const actionError = ref<string | null>(null)

onMounted(load)

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    members.value = await fetchMembers()
    phase.value = 'ready'
  } catch (err) {
    loadError.value = err as ApiError
    phase.value = 'error'
  }
}

/** 停用要 confirm；启用直接执行（启用是恢复性操作）。 */
async function onToggle(member: AdminMember): Promise<void> {
  const disabling = member.status === 'active'
  if (disabling && !window.confirm(disableHint(member))) return
  busyId.value = member.id
  actionError.value = null
  try {
    await setMemberStatus(member.id, disabling ? 'disabled' : 'active')
    member.status = disabling ? 'disabled' : 'active'
  } catch (err) {
    actionError.value = (err as ApiError).message
  } finally {
    busyId.value = null
  }
}

function disableHint(member: AdminMember): string {
  const name = member.display_name ?? member.email ?? member.id
  return `确定停用 ${name}？停用后该成员将无法登录，邮箱账户同步停用。`
}

function statusText(status: AdminMember['status']): string {
  return status === 'active' ? '正常' : '已停用'
}
</script>

<template>
  <div>
    <h1 class="page-title">成员</h1>

    <USkeleton v-if="phase === 'loading'" class="page-skeleton" />

    <UErrorCard
      v-else-if="phase === 'error'"
      :title="'成员列表加载失败'"
      :message="loadError?.message"
      :request-id="loadError?.requestId"
      :detail="loadError?.detail"
    />

    <div v-else class="member-list">
      <p v-if="actionError" class="form-alert" role="alert">{{ actionError }}</p>

      <p v-if="members.length === 0" class="page-empty">还没有成员</p>

      <div v-for="member in members" :key="member.id" class="member-row">
        <div class="member-who">
          <span class="member-name">{{ member.display_name ?? '（未设置名字）' }}</span>
          <span class="member-email">{{ member.email ?? '无邮箱' }}</span>
        </div>
        <span class="badge" :class="member.status === 'active' ? 'badge-ok' : 'badge-muted'">
          {{ statusText(member.status) }}
        </span>
        <span class="badge" :class="member.role === 'admin' ? 'badge-admin' : 'badge-muted'">
          {{ member.role === 'admin' ? '管理员' : '成员' }}
        </span>
        <span class="member-joined">加入于 {{ member.created_at }}</span>
        <UButton
          :variant="member.status === 'active' ? 'outline' : 'primary'"
          size="sm"
          :disabled="busyId !== null"
          @click="onToggle(member)"
        >
          <Ban v-if="member.status === 'active'" :size="14" aria-hidden="true" />
          <CircleCheck v-else :size="14" aria-hidden="true" />
          {{ member.status === 'active' ? '停用' : '启用' }}
        </UButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import './page.css';

.member-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.member-row {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-3) var(--unself-space-4);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-bg);
}
.member-who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.member-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-email {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-joined {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  white-space: nowrap;
}

@media (max-width: 768px) {
  .member-row {
    flex-wrap: wrap;
  }
  .member-who {
    flex-basis: 100%;
  }
  .member-joined {
    flex: 1;
  }
}
</style>
