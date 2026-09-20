<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Ban, CircleCheck, Check, Copy, MailPlus } from 'lucide-vue-next'

import { UButton, UCard, UErrorCard, USkeleton } from '@unself/ui'

import ConfirmDialog from '../components/ConfirmDialog.vue'
import {
  approveInvite,
  createInvite,
  fetchInvites,
  rejectInvite,
  type AdminInvite,
  type AdminInviteStatus,
  type ApiError,
} from '../lib/admin-api'
import { useLayerFocus } from '../lib/use-layer-focus'
import { useAsyncLoad } from '../lib/use-async-load'

/**
 * 管理台邀请页（#18）：申请列表 + 批准/拒绝 + 一次性生成邀请链接。
 * 令牌明文只在生成响应里出现一次，页面不做二次留存（关闭弹层即丢）。
 * 不做：批量审批、重新发送、邀请历史筛选。
 */

/** 有效期选项（天）；默认 7 天（与后端 DEFAULT_INVITE_EXPIRES_DAYS 同值）。 */
const EXPIRES_OPTIONS = [1, 3, 7, 14, 30] as const

/**
 * #307 复制反馈回弹窗口（beUI StatefulButton 口径 2s）。
 * JS 计时器吃毫秒数，与 CSS --unself-duration-* 同源取值：1.6s = normal(250ms)+slow(400ms)
 * 之外的用户感知窗口，取 beUI 口径整 2s（口径出处标注于此，非样式参数，verify-tokens 不涉）。
 */
const COPY_FEEDBACK_MS = 2000

// #142：加载三态样板收编 use-async-load（phase/loadError 变量名不变，模板零改动）
const { phase, loadError, data: invites } = useAsyncLoad<AdminInvite[]>(fetchInvites, { initial: [] })
/** 正在审批的邀请 id（按钮禁用防连点）。 */
const busyId = ref<string | null>(null)
/** 行内失败人话（按 token_hash 归属；加载失败才走错误卡）。 */
const rowError = ref<Record<string, string>>({})
/** 行内成功提示（批准结果人话，按 token_hash 归属）。 */
const rowNotice = ref<Record<string, string>>({})

// 生成弹层（#192 F5：Esc 关闭 + 焦点入内/回触发元素）
const showGenerate = ref(false)
const expiresDays = ref<number>(7)
const generating = ref(false)
const generateError = ref<string | null>(null)
const inviteUrl = ref<string | null>(null)
const generateLayer = ref<HTMLElement | null>(null)
const { onKeydown: onGenerateKeydown } = useLayerFocus(showGenerate, () => generateLayer.value)

/** 批准直接执行（不可逆但为正常推进）；状态行内翻转 + 开户结果人话。 */
async function onApprove(invite: AdminInvite): Promise<void> {
  if (busyId.value !== null) return
  busyId.value = invite.token_hash
  delete rowError.value[invite.token_hash]
  delete rowNotice.value[invite.token_hash]
  try {
    const result = await approveInvite(invite.token_hash)
    invite.status = 'approved'
    rowNotice.value[invite.token_hash] = result.email
      ? `已开户 ${result.email}，激活链接已发至个人邮箱`
      : approveNotice(invite)
  } catch (err) {
    rowError.value[invite.token_hash] = humanError(err)
  } finally {
    busyId.value = null
  }
}

/**
 * 弱化实例批准人话按身份轴分流（#192 F8）：
 * - 内置注册者：填表时已自设登录密码，批准即入职，不存在「首登匹配」环节
 * - OIDC 首登者：无内置凭证，首次登录 JIT 按个人邮箱消费邀请（原文案口径）
 * 前端可判依据 = email_prefix（内置注册必填前缀；OIDC 弱化路径免填表单前缀）。
 */
function approveNotice(invite: AdminInvite): string {
  return invite.email_prefix
    ? '已批准：新人用填表时设置的用户名密码登录即可'
    : '已批准（弱化实例：首次登录按个人邮箱匹配入职）'
}

/**
 * 拒绝改站内确认（#192 F6 去原生弹窗）：
 * 只开弹层不发改；确认后才 rejectInvite，语义与原 confirm 二次确认一致。
 */
const rejectTarget = ref<AdminInvite | null>(null)
/** v-model 双向：ConfirmDialog 开合（拒绝目标随开合维护）。 */
const rejectOpen = computed({
  get: () => rejectTarget.value !== null,
  set: (open: boolean) => {
    if (!open) rejectTarget.value = null
  },
})

function onReject(invite: AdminInvite): void {
  if (busyId.value !== null) return
  rejectTarget.value = invite
}

async function onRejectConfirm(): Promise<void> {
  const invite = rejectTarget.value
  if (!invite) return
  rejectTarget.value = null
  busyId.value = invite.token_hash
  delete rowError.value[invite.token_hash]
  delete rowNotice.value[invite.token_hash]
  try {
    await rejectInvite(invite.token_hash)
    invite.status = 'rejected'
  } catch (err) {
    rowError.value[invite.token_hash] = humanError(err)
  } finally {
    busyId.value = null
  }
}

function openGenerate(): void {
  showGenerate.value = true
  expiresDays.value = 7
  generating.value = false
  generateError.value = null
  inviteUrl.value = null
}

function closeGenerate(): void {
  showGenerate.value = false
  // 清掉一次性链接明文（只显示一次）
  inviteUrl.value = null
  generateError.value = null
}

async function onGenerate(): Promise<void> {
  generating.value = true
  generateError.value = null
  try {
    const result = await createInvite(expiresDays.value)
    inviteUrl.value = result.inviteUrl
  } catch (err) {
    generateError.value = humanError(err)
  } finally {
    generating.value = false
  }
}

/** 复制成功反馈（#307 ②状态叙事，beUI StatefulButton 模式）：同位换「已复制 ✓」，2s 回弹。 */
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/** 复制失败静默（剪贴板权限/非安全上下文都可能失败，不打断发链接流程）。 */
async function onCopy(): Promise<void> {
  if (!inviteUrl.value) return
  try {
    await navigator.clipboard?.writeText(inviteUrl.value)
    // 复制成功才给反馈：同位换文案 + 描边变成功色，2s 后回弹（可再次复制给第二个人）
    copied.value = true
    if (copiedTimer !== null) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
      copiedTimer = null
    }, COPY_FEEDBACK_MS)
  } catch {
    /* 静默：用户仍可手动选中复制 */
  }
}

onBeforeUnmount(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer)
})

/** 审批失败人话：后端 detail 优先，退化到 ApiError.message。 */
function humanError(err: unknown): string {
  const apiErr = err as ApiError
  return apiErr.detail ?? apiErr.message
}

function rejectHint(invite: AdminInvite): string {
  const who = invite.display_name || invite.personal_email || invite.email_prefix || invite.token_hash
  return `确定拒绝 ${who} 的加入申请？拒绝后不可撤销。`
}

const STATUS_TEXT: Record<AdminInviteStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  consumed: '已入职',
  expired: '已过期',
}

function statusText(status: AdminInviteStatus): string {
  return STATUS_TEXT[status]
}

function statusClass(status: AdminInviteStatus): string {
  switch (status) {
    case 'approved':
    case 'consumed':
      return 'badge-ok'
    case 'rejected':
      return 'badge-danger'
    case 'expired':
      return 'badge-muted'
    default:
      return 'badge-warn'
  }
}

/** 申请内容行：邮箱前缀（未填表则提示）+ 个人邮箱。 */
function applicantLine(invite: AdminInvite): string {
  const prefix = invite.email_prefix ? `@${invite.email_prefix}` : '（未填表）'
  const email = invite.personal_email || '（未填个人邮箱）'
  return `${prefix} · ${email}`
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1 class="page-title">邀请</h1>
      <UButton @click="openGenerate">
        <MailPlus :size="16" aria-hidden="true" />
        生成邀请
      </UButton>
    </div>

    <USkeleton v-if="phase === 'loading'" class="page-skeleton" />

    <UErrorCard
      v-else-if="phase === 'error'"
      title="邀请列表加载失败"
      :message="loadError?.message"
      :request-id="loadError?.requestId"
      :detail="loadError?.detail"
    />

    <div v-else class="invite-list">
      <p v-if="invites.length === 0" class="page-empty">还没有邀请</p>

      <div
        v-for="invite in invites"
        :key="invite.token_hash"
        class="invite-row"
        data-test="invite-row"
      >
        <div class="invite-who">
          <span class="invite-name">{{ invite.display_name || '（未填写）' }}</span>
          <span class="invite-applicant">{{ applicantLine(invite) }}</span>
        </div>

        <span class="badge" :class="statusClass(invite.status)">{{ statusText(invite.status) }}</span>

        <span class="invite-time">创建于 {{ invite.created_at }} · 过期于 {{ invite.expires_at }}</span>

        <div v-if="invite.status === 'pending'" class="invite-actions">
          <UButton
            size="sm"
            :loading="busyId === invite.token_hash"
            :disabled="busyId !== null"
            @click="onApprove(invite)"
          >
            <CircleCheck :size="14" aria-hidden="true" />
            批准
          </UButton>
          <UButton size="sm" variant="outline" :disabled="busyId !== null" @click="onReject(invite)">
            <Ban :size="14" aria-hidden="true" />
            拒绝
          </UButton>
        </div>

        <p v-if="rowError[invite.token_hash]" class="form-alert invite-message" role="alert">
          {{ rowError[invite.token_hash] }}
        </p>
        <p v-else-if="rowNotice[invite.token_hash]" class="invite-notice invite-message" role="status">
          {{ rowNotice[invite.token_hash] }}
        </p>
      </div>
    </div>

    <div v-if="showGenerate" class="invite-scrim" @click.self="closeGenerate">
      <UCard padding="lg" class="invite-modal">
        <div
          ref="generateLayer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-generate-title"
          tabindex="-1"
          @keydown="onGenerateKeydown"
        >
          <h2 id="invite-generate-title" class="invite-modal-title">生成邀请</h2>

          <template v-if="!inviteUrl">
            <label class="invite-modal-label" for="invite-days">有效期</label>
            <select id="invite-days" v-model.number="expiresDays" class="invite-select">
              <option v-for="days in EXPIRES_OPTIONS" :key="days" :value="days">{{ days }} 天</option>
            </select>

            <p v-if="generateError" class="form-alert invite-message" role="alert">{{ generateError }}</p>

            <div class="invite-modal-actions">
              <UButton :loading="generating" @click="onGenerate">生成</UButton>
              <UButton variant="outline" @click="closeGenerate">关闭</UButton>
            </div>
          </template>

          <template v-else>
            <p class="invite-modal-hint">链接只显示一次，请立即复制并发给对方</p>
            <div class="invite-link-row">
              <input
                data-test="invite-url"
                class="invite-link"
                :value="inviteUrl"
                readonly
                aria-label="邀请链接"
              >
              <UButton
                variant="outline"
                class="invite-copy-btn"
                :class="{ 'invite-copy-btn-done': copied }"
                :aria-label="copied ? '已复制' : '复制'"
                @click="onCopy"
              >
                <span v-if="copied" class="invite-copy-done" role="status">
                  <Check :size="14" aria-hidden="true" />
                  已复制
                </span>
                <span v-else class="invite-copy-idle">
                  <Copy :size="14" aria-hidden="true" />
                  复制
                </span>
              </UButton>
            </div>
            <div class="invite-modal-actions">
              <UButton variant="outline" @click="closeGenerate">关闭</UButton>
            </div>
          </template>
        </div>
      </UCard>
    </div>
    <!-- 拒绝二次确认（#192 F6：站内确认替代 window.confirm） -->
    <ConfirmDialog
      v-model="rejectOpen"
      kind="danger"
      title="拒绝加入申请"
      :message="rejectTarget ? rejectHint(rejectTarget) : ''"
      confirm-label="拒绝"
      @confirm="onRejectConfirm"
    />
  </div>
</template>

<style scoped>
@import './page.css';

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
}
.page-head .page-title {
  margin: 0;
}

.invite-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.invite-row {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-3) var(--unself-space-4);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-bg);
  flex-wrap: wrap;
}
.invite-who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.invite-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.invite-applicant {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.invite-time {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  white-space: nowrap;
}
.invite-actions {
  display: flex;
  gap: var(--unself-space-2);
}
.invite-message {
  flex-basis: 100%;
}
.invite-notice {
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font-size: var(--unself-font-size-sm);
}
/* 已拒绝徽章：danger 令牌（page.css 无 danger 徽章） */
.badge-danger {
  background: var(--unself-color-danger-soft);
  color: var(--unself-color-danger);
}

/* 生成弹层：遮罩 + 卡片（居中；点遮罩关闭） */
.invite-scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-scrim);
}
.invite-modal {
  width: min(480px, 100%);
}
.invite-modal-title {
  margin: 0 0 var(--unself-space-4);
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
}
.invite-modal-label {
  display: block;
  margin-bottom: var(--unself-space-1);
  padding: 0 var(--unself-space-1);
  font-size: var(--unself-font-size-sm);
  font-weight: 500;
  color: var(--unself-color-text);
}
.invite-select {
  width: 100%;
  height: 40px;
  padding: 0 var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-base);
}
.invite-select:focus {
  outline: none;
  border-color: var(--unself-color-primary);
  box-shadow: 0 0 0 3px var(--unself-color-primary-soft);
}
.invite-modal-hint {
  margin: 0 0 var(--unself-space-3);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.invite-link-row {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.invite-link {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-sm);
}
.invite-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--unself-space-2);
  margin-top: var(--unself-space-4);
}

/* #307 ②状态叙事：复制→已复制 同位换位（beUI StatefulButton 模式）。
   两态 span 定格在同位（按钮固定最小宽防跳动），切换走 ease-spring 微弹。 */
.invite-copy-btn {
  min-width: 84px;
}
.invite-copy-idle,
.invite-copy-done {
  display: inline-flex;
  align-items: center;
  gap: var(--unself-space-1);
}
.invite-copy-done {
  color: var(--unself-color-success);
  animation: invite-copy-pop var(--unself-duration-normal) var(--unself-ease-spring);
}
@keyframes invite-copy-pop {
  from {
    opacity: 0;
    transform: scale(0.75);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
/* 降低动效偏好：弹跳归零——同位文案即时切换（反馈语义保留，只是不动） */
@media (prefers-reduced-motion: reduce) {
  .invite-copy-done {
    animation: none;
  }
}
.invite-modal > div > p.invite-message {
  margin-top: var(--unself-space-3);
}

/* #181：窄屏下批准/拒绝是高频危险操作，热区 ≥44px（按钮视觉尺寸由 UButton 决定，这里只抬下限） */
@media (max-width: 768px) {
  .invite-actions :deep(.u-btn) {
    min-height: var(--unself-touch-target);
  }
}

@media (max-width: 768px) {
  .invite-who {
    flex-basis: 100%;
  }
  .invite-time {
    flex: 1;
  }
}
</style>
