<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyRound, LogIn, MailCheck } from 'lucide-vue-next'
import { UButton, UCard, UErrorCard, UInput } from '@unself/ui'
import { activateAccount, fetchActivation } from './lib/invite-api'

/**
 * 公开激活页（#18，/activate/:token；无侧栏独立壳，不登登录）：
 * - 挂载即读链接：GET /api/activate/<token> → 展示工作邮箱；失败 → 错误卡（人话来自服务端）
 * - 本地校验 ≥8 位且两次一致（不满足 → 行内人话，不发请求）→ POST 自设密码
 * - 成功 → 「激活完成」+ 服务端 loginHint + 「去登录」
 *
 * 拍板口径（2026-09-10，SPEC §5.7）：这里的密码是**邮箱密码**，
 * Unself 不做密码同步；若团队登录走独立 IdP，登录账户另找管理员。
 * 页面上两句说明是产品语义本身，不是装饰文案。
 */

const route = useRoute()
const router = useRouter()
const token = String(route.params.token)

type Phase = 'loading' | 'form' | 'error' | 'done'

const phase = ref<Phase>('loading')
const loadError = ref('')
const email = ref('')

const password = ref('')
const passwordConfirm = ref('')
const fieldErrors = ref<{ password?: string; passwordConfirm?: string }>({})
const submitting = ref(false)
const submitError = ref('')
const loginHint = ref('')

onMounted(async () => {
  try {
    const activation = await fetchActivation(token)
    email.value = activation.email
    phase.value = 'form'
  } catch (err) {
    loadError.value = (err as Error).message
    phase.value = 'error'
  }
})

/** 本地校验：≥8 位且两次一致（弱口令策略归服务端，前端只拦明显无效输入）。 */
function validate(): boolean {
  const errors: typeof fieldErrors.value = {}
  if (password.value.length < 8) {
    errors.password = '密码至少 8 位'
  } else if (passwordConfirm.value !== password.value) {
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
    const result = await activateAccount(token, password.value)
    loginHint.value = result.loginHint
    phase.value = 'done'
  } catch (err) {
    submitError.value = (err as Error).message
  } finally {
    submitting.value = false
  }
}

function goLogin() {
  void router.push('/login')
}
</script>

<template>
  <main class="activate-page">
    <UCard padding="lg" class="activate-card">
      <p v-if="phase === 'loading'" class="activate-loading" role="status">正在加载激活链接…</p>

      <UErrorCard v-else-if="phase === 'error'" title="激活链接不可用" :message="loadError" />

      <div v-else-if="phase === 'done'" class="activate-done" role="status">
        <MailCheck class="activate-done-icon" :size="28" aria-hidden="true" />
        <h1 class="activate-title">激活完成</h1>
        <p class="activate-desc">{{ loginHint }}</p>
        <UButton size="lg" class="activate-submit" @click="goLogin">
          <LogIn :size="16" aria-hidden="true" />
          去登录
        </UButton>
      </div>

      <form v-else class="activate-form" @submit.prevent="onSubmit">
        <div class="activate-head">
          <KeyRound class="activate-head-icon" :size="24" aria-hidden="true" />
          <h1 class="activate-title">设置你的邮箱密码</h1>
        </div>
        <p class="activate-email">工作邮箱：<strong>{{ email }}</strong></p>
        <p class="activate-hint">此密码用于登录你的邮箱（{{ email }}）；若团队登录走独立 IdP，登录账户请联系管理员。</p>
        <p class="activate-note">这是邮箱密码，不是工作台登录密码。</p>

        <UErrorCard v-if="submitError" title="激活没有成功" :message="submitError" />

        <UInput
          v-model="password"
          label="新密码"
          type="password"
          name="password"
          autocomplete="new-password"
          required
          :error="fieldErrors.password ?? false"
          reserve-error-line
        />
        <UInput
          v-model="passwordConfirm"
          label="确认新密码"
          type="password"
          name="password_confirm"
          autocomplete="new-password"
          required
          :error="fieldErrors.passwordConfirm ?? false"
          reserve-error-line
        />

        <UButton type="submit" size="lg" class="activate-submit" :loading="submitting">
          <KeyRound :size="16" aria-hidden="true" />
          激活邮箱账号
        </UButton>
      </form>
    </UCard>
  </main>
</template>

<style scoped>
.activate-page {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-surface);
}
.activate-card {
  width: 100%;
  max-width: 420px;
}
.activate-loading {
  margin: 0;
  text-align: center;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.activate-head {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.activate-head-icon {
  flex-shrink: 0;
  color: var(--unself-color-primary);
}
.activate-title {
  margin: 0;
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.activate-email {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text);
}
.activate-hint {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.activate-note {
  margin: 0;
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}
.activate-form {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}
.activate-submit {
  width: 100%;
  margin-top: var(--unself-space-1);
}
.activate-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-3);
  text-align: center;
  padding: var(--unself-space-6) 0;
}
.activate-done-icon {
  color: var(--unself-color-success);
}
.activate-desc {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
</style>
