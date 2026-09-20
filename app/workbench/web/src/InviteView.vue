<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyRound, LogIn, MailCheck, RefreshCw, Send, UserPlus } from 'lucide-vue-next'
import { UButton, UCard, UErrorCard, UInput } from '@unself/ui'
import {
  claimInviteActivation,
  fetchInvite,
  fetchInviteStatus,
  submitInvite,
  type InviteApplication,
  type InviteSubmission,
} from './lib/invite-api'
import type { InviteStatusResponse } from '@unself/contracts'
import { generateSalt, deriveProof } from './lib/pk1'

/**
 * 公开邀请页（#18 /invite/:token；无侧栏独立壳，不登登录；issue-A 内置注册含用户名+密码）：
 * - 挂载即读链接：GET /api/invite/<token>；失败 → 错误卡（标题固定，人话来自服务端，无重试）
 * - 提交前本地校验：三字段非空 + 用户名格式 + 密码≥8 + 两次一致；重名 409 由服务端软闸返回人话
 * - 提交成功 → #134 状态轮询视图（三态，凭同一邀请令牌即身份）：
 *   · pending   →「管理员审批中」+ 手动刷新（不自动死循环，间隔 ≥5s 才轮询）
 *   · approved  →「设置邮箱密码」大按钮 → claim 重签激活 → 跳 activationUrl
 *   · activated →「全部就绪，去登录页使用邮箱密码登录」
 * - #149 实例能力开关 mailEnabled（status 响应唯一真相源）：无邮件实例不渲染
 *   邮箱两字段、提交不带这两键；approved 即激活（无开户动作）→「全部就绪」。
 *   mailEnabled=true 时所有文案与行为逐字不变。
 */

const route = useRoute()
const router = useRouter()
const token = String(route.params.token)

type Phase = 'loading' | 'form' | 'error' | 'submitted' | 'approved' | 'activated'

const phase = ref<Phase>('loading')
const loadError = ref('')
const submitting = ref(false)
const submitError = ref('')

/** #149 实例能力开关：仅由 status 响应写入（mailEnabled=true 前提下行为与文案零变化）。 */
const mailEnabled = ref(true)

/** #134 状态轮询：视图态与请求在途态分开（按钮 loading 不换文案）。 */
const statusRefreshing = ref(false)
const claiming = ref(false)
const claimError = ref('')
/** 轮询定时器句柄；null = 无自动轮询在跑。 */
let pollTimer: ReturnType<typeof setTimeout> | null = null
/** 轮询间隔（ms）：拍板 ≥5s，手动刷新永远可用。 */
const POLL_INTERVAL_MS = 5000

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

/** 三态 → 视图态：只认 pending/approved/activated；其余（失效）按错误卡展示。 */
function applyStatus(response: InviteStatusResponse): void {
  mailEnabled.value = response.mailEnabled
  claimError.value = ''
  if (response.status === 'pending') {
    phase.value = 'submitted'
    schedulePoll()
  } else if (response.status === 'approved') {
    stopPolling()
    phase.value = 'approved'
  } else {
    stopPolling()
    phase.value = 'activated'
  }
}

/** 查一次状态并套用；失效（404/410）→ 错误卡并停止轮询。 */
async function refreshStatus(): Promise<void> {
  statusRefreshing.value = true
  try {
    applyStatus(await fetchInviteStatus(token))
  } catch (err) {
    stopPolling()
    loadError.value = (err as Error).message
    phase.value = 'error'
  } finally {
    statusRefreshing.value = false
  }
}

/** 手动刷新按钮：立即查一次状态。 */
async function onManualRefresh(): Promise<void> {
  if (statusRefreshing.value) return
  await refreshStatus()
}

/**
 * 自动轮询：≥5s 一拍，组件卸载/离开三态即清；pending 才续拍，绝不死循环打接口。
 * document.hidden 时跳过本轮（后台标签页不打扰服务端）。
 */
function schedulePoll(): void {
  stopPolling()
  pollTimer = setTimeout(async () => {
    if (document.hidden) {
      schedulePoll()
      return
    }
    try {
      const response = await fetchInviteStatus(token)
      if (response.status === 'pending') {
        schedulePoll()
        return
      }
      applyStatus(response)
    } catch {
      // 轮询失败不掀桌：保持 pending 视图，等下一拍或手动刷新
      schedulePoll()
    }
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

/** claim：重签激活链接（旧链接作废）→ 同壳路由跳激活页设邮箱密码。 */
async function onClaim(): Promise<void> {
  if (claiming.value) return
  claiming.value = true
  claimError.value = ''
  try {
    const { activationUrl } = await claimInviteActivation(token)
    stopPolling()
    // activationUrl 是服务端拼的绝对地址；同源才 SPA 跳转，非同源整页走
    const target = new URL(activationUrl, window.location.origin)
    if (target.origin === window.location.origin) {
      await router.push(target.pathname)
    } else {
      window.location.assign(activationUrl)
    }
  } catch (err) {
    claimError.value = (err as Error).message
    // 服务端说已激活/失效 → 状态已变，刷一次把视图带回正确态
    if (claimError.value.includes('已激活')) {
      await refreshStatus()
    }
  } finally {
    claiming.value = false
  }
}

/** 全部就绪：去登录页（登录用邮箱账号 + 刚设置的邮箱密码）。 */
function onGoLogin(): void {
  void router.push('/login')
}

/** #149 全部就绪描述：有邮件提密码已设；无邮件批准即激活，无密码可提。 */
const readyDesc = computed(() =>
  mailEnabled.value
    ? '邮箱密码已设置完成。请前往登录页，使用邮箱与密码登录。'
    : '账号已激活，请前往登录页登录。',
)

onMounted(async () => {
  try {
    const invite = await fetchInvite(token)
    application.displayName = invite.displayName ?? ''
    application.emailPrefix = invite.emailPrefix ?? ''
    application.personalEmail = invite.personalEmail ?? ''
    // 读表单与读状态之间可能被批准：pending 才留表单，否则直接套用最新状态（#149 竞态防御）
    const status = await fetchInviteStatus(token)
    if (status.status === 'pending') {
      // #149：能力开关同样只认 status 响应，无邮件实例表单不渲染邮箱字段
      mailEnabled.value = status.mailEnabled
      phase.value = 'form'
    } else {
      applyStatus(status)
    }
  } catch {
    // 已提交过的链接（410）不再能读表单：直接进入状态轮询视图（#134 主路径）
    await refreshStatus()
  }
})

onBeforeUnmount(stopPolling)

/** 本地校验只查非空与格式（唯一性归服务端软闸，前端不重复防御）。 */
function validate(): boolean {
  const errors: typeof fieldErrors.value = {}
  if (application.displayName.trim().length === 0) errors.displayName = '请填写显示名'
  // #149：无邮件实例无邮箱字段，两邮箱校验整体跳过（行内错误随 errors 重建自然清空）
  if (mailEnabled.value) {
    if (application.emailPrefix.trim().length === 0) errors.emailPrefix = '请填写邮箱前缀'
    if (application.personalEmail.trim().length === 0) errors.personalEmail = '请填写个人邮箱'
  }
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

/**
 * 提交载荷（#149）：有邮件实例带邮箱两字段（现行为零变化）；无邮件实例
 * body 完全不带这两键（省略而非显式 undefined，服务端两字段可省）。
 */
function buildSubmission(
  username: string | undefined,
  credentials: { salt: string; proof: string } | undefined,
): InviteSubmission {
  const body: InviteSubmission = {
    displayName: application.displayName.trim(),
    username,
    ...credentials,
  }
  if (mailEnabled.value) {
    body.emailPrefix = application.emailPrefix.trim()
    body.personalEmail = application.personalEmail.trim()
  }
  return body
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
    await submitInvite(token, buildSubmission(username, credentials))
    // 提交成功即进入状态轮询（#134）：先立刻查一次，pending 才挂自动轮询
    await refreshStatus()
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
        <h1 class="invite-title">管理员审批中</h1>
        <!-- #149：mailEnabled=true 保现文案逐字不变；无邮件实例批准即激活，无设密入口 -->
        <p v-if="mailEnabled" class="invite-desc">申请已提交。管理员批准后，本页会出现「设置邮箱密码」入口；你也可以稍后回来刷新。</p>
        <p v-else class="invite-desc">申请已提交。管理员批准后即可直接登录；你也可以稍后回来刷新。</p>
        <UButton
          class="invite-refresh"
          variant="outline"
          :loading="statusRefreshing"
          data-test="refresh-status"
          @click="onManualRefresh"
        >
          <RefreshCw :size="16" aria-hidden="true" />
          刷新状态
        </UButton>
      </div>

      <!-- #149：有邮件实例 approved = 待设邮箱密码（逐字零变化）；无邮件 approved 即激活，与 activated 同视图 -->
      <div
        v-else-if="phase === 'approved' && mailEnabled"
        class="invite-done"
        role="status"
      >
        <KeyRound class="invite-done-icon" :size="28" aria-hidden="true" />
        <h1 class="invite-title">管理员已批准！</h1>
        <p class="invite-desc">最后一步：设置你的邮箱密码，设置完成后即可使用邮箱登录。</p>
        <UErrorCard v-if="claimError" title="无法进入激活" :message="claimError" />
        <UButton size="lg" class="invite-submit" :loading="claiming" data-test="claim-activation" @click="onClaim">
          <KeyRound :size="16" aria-hidden="true" />
          设置邮箱密码
        </UButton>
      </div>

      <div v-else-if="phase === 'approved' || phase === 'activated'" class="invite-done" role="status">
        <MailCheck class="invite-done-icon" :size="28" aria-hidden="true" />
        <h1 class="invite-title">全部就绪</h1>
        <p class="invite-desc">{{ readyDesc }}</p>
        <UButton size="lg" class="invite-submit" data-test="go-login" @click="onGoLogin">
          <LogIn :size="16" aria-hidden="true" />
          去登录
        </UButton>
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
          v-if="mailEnabled"
          v-model="application.emailPrefix"
          label="邮箱前缀"
          name="email_prefix"
          autocomplete="off"
          required
          :error="fieldErrors.emailPrefix ?? false"
          reserve-error-line
        />
        <UInput
          v-if="mailEnabled"
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
.invite-refresh {
  width: 100%;
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
