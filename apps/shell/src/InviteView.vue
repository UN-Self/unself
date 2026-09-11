<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { MailCheck, Send, UserPlus } from 'lucide-vue-next'
import { UButton, UCard, UErrorCard, UInput } from '@unself/ui'
import { fetchInvite, submitInvite, type InviteApplication } from './lib/invite-api'
import { generateSalt, deriveProof } from './lib/pk1'

/**
 * 公开邀请填表页（#18，/invite/:token；无侧栏独立壳，不登登录；issue-A 内置注册含用户名+密码）：
 * - 挂载即读链接：GET /api/invite/<token>；失败 → 错误卡（标题固定，人话来自服务端，无重试）
 * - 提交前本地校验：三字段非空 + 用户名格式 + 密码≥8 + 两次一致；重名 409 由服务端软闸返回人话
 * - 成功 → 同卡切「申请已提交，等待管理员审批」（链接一次性，不重复提交）
 */

const route = useRoute()
const token = String(route.params.token)

type Phase = 'loading' | 'form' | 'error' | 'submitted'

const phase = ref<Phase>('loading')
const loadError = ref('')
const submitting = ref(false)
const submitError = ref('')

/** 表单本地态：password 仅存在于浏览器内存，提交前派生成盐+R（pk1）。 */
const application = reactive<InviteApplication & { password?: string; passwordConfirm?: string }>({
  displayName: '',
  emailPrefix: '',
  personalEmail: '',
  username: '',
  password: '',
  passwordConfirm: '',
})

const fieldErrors = ref<{
  displayName?: string
  emailPrefix?: string
  personalEmail?: string
  username?: string
  password?: string
  passwordConfirm?: string
}>({})

onMounted(async () => {
  try {
    const invite = await fetchInvite(token)
    application.displayName = invite.displayName ?? ''
    application.emailPrefix = invite.emailPrefix ?? ''
    application.personalEmail = invite.personalEmail ?? ''
    phase.value = 'form'
  } catch (err) {
    loadError.value = (err as Error).message
    phase.value = 'error'
  }
})

/** 本地校验只查非空与格式（唯一性归服务端软闸，前端不重复防御）。 */
function validate(): boolean {
  const errors: typeof fieldErrors.value = {}
  if (application.displayName.trim().length === 0) errors.displayName = '请填写显示名'
  if (application.emailPrefix.trim().length === 0) errors.emailPrefix = '请填写邮箱前缀'
  if (application.personalEmail.trim().length === 0) errors.personalEmail = '请填写个人邮箱'
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(application.username ?? '')) {
    errors.username = '用户名需为 3-32 位字母/数字/_/-'
  }
  if ((application.password ?? '').length < 8) {
    errors.password = '密码长度至少 8 位'
  }
  if (application.passwordConfirm !== application.password || (application.passwordConfirm ?? '').length === 0) {
    errors.passwordConfirm = '两次输入的密码不一致'
  }
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

async function onSubmit() {
  submitError.value = ''
  if (!validate()) return
  submitting.value = true
  try {
    const username = application.username?.trim()
    let credentials: { salt: string; proof: string } | undefined
    if (username) {
      const salt = generateSalt()
      credentials = { salt, proof: await deriveProof(application.password ?? '', salt) }
    }
    await submitInvite(token, {
      displayName: application.displayName.trim(),
      emailPrefix: application.emailPrefix.trim(),
      personalEmail: application.personalEmail.trim(),
      username,
      ...credentials,
    })
    phase.value = 'submitted'
  } catch (err) {
    submitError.value = (err as Error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="invite-page">
    <UCard padding="lg" class="invite-card">
      <p v-if="phase === 'loading'" class="invite-loading" role="status">正在加载邀请链接…</p>

      <UErrorCard v-else-if="phase === 'error'" title="邀请链接不可用" :message="loadError" />

      <div v-else-if="phase === 'submitted'" class="invite-done" role="status">
        <MailCheck class="invite-done-icon" :size="28" aria-hidden="true" />
        <h1 class="invite-title">申请已提交，等待管理员审批</h1>
        <p class="invite-desc">审批结果会通过邮件与站内通知告知，链接一次性有效，请勿重复提交。</p>
      </div>

      <form v-else class="invite-form" @submit.prevent="onSubmit">
        <div class="invite-head">
          <UserPlus class="invite-head-icon" :size="24" aria-hidden="true" />
          <h1 class="invite-title">填写你的申请信息</h1>
        </div>
        <p class="invite-desc">请确认以下信息真实有效，管理员将据此为你开通账号。</p>

        <UErrorCard v-if="submitError" title="提交没有成功" :message="submitError" />

        <UInput
          v-model="application.displayName"
          label="显示名"
          name="display_name"
          autocomplete="name"
          required
          :error="fieldErrors.displayName ?? false"
          reserve-error-line
        />
        <UInput
          v-model="application.username"
          label="用户名"
          name="username"
          autocomplete="username"
          placeholder="3-32 位字母/数字/_/-，登录用"
          required
          :error="fieldErrors.username ?? false"
          reserve-error-line
        />
        <UInput
          v-model="application.password"
          label="登录密码"
          type="password"
          name="password"
          autocomplete="new-password"
          required
          :error="fieldErrors.password ?? false"
          reserve-error-line
        />
        <UInput
          v-model="application.passwordConfirm"
          label="重复密码"
          type="password"
          name="password_confirm"
          autocomplete="new-password"
          required
          :error="fieldErrors.passwordConfirm ?? false"
          reserve-error-line
 />
        <UInput
          v-model="application.emailPrefix"
          label="邮箱前缀"
          name="email_prefix"
          autocomplete="off"
          required
          :error="fieldErrors.emailPrefix ?? false"
          reserve-error-line
        />
        <UInput
          v-model="application.personalEmail"
          label="个人邮箱"
          type="email"
          name="personal_email"
          autocomplete="email"
          required
          :error="fieldErrors.personalEmail ?? false"
          reserve-error-line
        />

        <UButton type="submit" size="lg" class="invite-submit" :loading="submitting">
          <Send :size="16" aria-hidden="true" />
          提交申请
        </UButton>
      </form>
    </UCard>
  </main>
</template>

<style scoped>
.invite-page {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-surface);
}
.invite-card {
  width: 100%;
  max-width: 420px;
}
.invite-loading {
  margin: 0;
  text-align: center;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.invite-head {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.invite-head-icon {
  flex-shrink: 0;
  color: var(--unself-color-primary);
}
.invite-title {
  margin: 0;
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.invite-desc {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.invite-form {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}
.invite-submit {
  width: 100%;
  margin-top: var(--unself-space-1);
}
.invite-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-3);
  text-align: center;
  padding: var(--unself-space-6) 0;
}
.invite-done-icon {
  color: var(--unself-color-success);
}
</style>
