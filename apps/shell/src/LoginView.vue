<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyRound, LogIn } from 'lucide-vue-next'
import { UButton, UCard, UErrorCard, UInput } from '@unself/ui'
import { humanizeLoginError } from './lib/login-error'
import { getAuthMethods, loginWithPassword, type AuthError } from './lib/builtin-auth-api'

/**
 * 登录页（#11，§6.5 动线；issue-A 内置密码为默认，OIDC 为可选增强）：
 * - 默认：用户名+密码表单 → POST /api/auth/login → 会话 Cookie → 回原目标
 * - 实例配置了 OIDC（GET /api/auth/methods oidc=true）→ 显「SSO 登录」按钮（整页跳转）
 * - 登录后落地：next 回原目标（#12 工作台消费），直访落第一个启用模块
 */

const route = useRoute()
const router = useRouter()

const instanceName = 'Unself 工作台'
const username = ref('')
const password = ref('')
const fieldError = ref('')
const formError = ref('')
const submitting = ref(false)
const ssoEnabled = ref(false)
const redirecting = ref(false)
// OIDC 回跳失败（callback 带错误参数）时展示人话；不暴露原始报错（#83 按错误码分档）
const loginError = computed(() => humanizeLoginError(route.query.error))

onMounted(async () => {
  // SSO 按钮显隐按实例配置（决策 20）；探测失败静默降级（内置密码仍可用）
  try {
    const methods = await getAuthMethods()
    ssoEnabled.value = methods.oidc
  } catch {
    ssoEnabled.value = false
  }
})

function validate(): boolean {
  if (username.value.trim().length === 0) {
    fieldError.value = '请填写用户名'
    return false
  }
  fieldError.value = ''
  return true
}

async function onSubmit() {
  formError.value = ''
  if (!validate()) return
  submitting.value = true
  try {
    await loginWithPassword(username.value.trim(), password.value)
    const next = typeof route.query.next === 'string' ? route.query.next : undefined
    await router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/')
  } catch (err) {
    // 后端 404/401 统一「用户名或密码错误」（人话直接透传），403 停用人话
    formError.value = (err as AuthError).message
  } finally {
    submitting.value = false
  }
}

function startSsoLogin() {
  redirecting.value = true
  const next = typeof route.query.next === 'string' ? route.query.next : undefined
  // 整页跳转（非 SPA 内路由）：登录页发生在 IdP，返回后 shell 重新加载
  const target = next && next.startsWith('/') && !next.startsWith('//')
    ? `/api/auth/login?next=${encodeURIComponent(next)}`
    : '/api/auth/login'
  window.location.assign(target)
}

// 兜底：已登录用户访问 /login 直接进工作台
void (async () => {
  const { fetchMe } = await import('./lib/session-api')
  const me = await fetchMe()
  if (me.authenticated) {
    await router.replace('/')
  }
})()
</script>

<template>
  <main class="login-page">
    <UCard padding="lg" class="login-card">
      <div class="login-body">
        <h1 class="login-title">{{ instanceName }}</h1>
        <p class="login-subtitle">使用你的团队账号登录</p>

        <UErrorCard
          v-if="loginError"
          class="login-error"
          :title="loginError.title"
          :message="loginError.message"
          retry-label="重新登录"
          @retry="startSsoLogin"
        />

        <form class="login-form" @submit.prevent="onSubmit">
          <p v-if="formError" class="login-inline-error" role="alert">{{ formError }}</p>
          <UInput
            v-model="username"
            label="用户名"
            name="username"
            autocomplete="username"
            required
            :error="fieldError"
            reserve-error-line
          />
          <UInput
            v-model="password"
            label="密码"
            type="password"
            name="password"
            autocomplete="current-password"
            required
            reserve-error-line
          />
          <UButton type="submit" size="lg" class="login-button" :loading="submitting">
            <KeyRound :size="16" aria-hidden="true" />
            登录
          </UButton>
        </form>

        <UButton
          v-if="ssoEnabled"
          variant="outline"
          size="lg"
          class="login-button"
          :disabled="redirecting"
          @click="startSsoLogin"
        >
          <LogIn :size="16" aria-hidden="true" />
          SSO 登录
        </UButton>
      </div>
    </UCard>
  </main>
</template>

<style scoped>
.login-page {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-surface);
}
.login-card {
  width: 100%;
  max-width: 380px;
}
.login-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-4);
  text-align: center;
}
.login-title {
  margin: 0;
  font-size: var(--unself-font-size-2xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.login-subtitle {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.login-error {
  width: 100%;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
  width: 100%;
  text-align: left;
}
.login-inline-error {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-danger);
}
.login-button {
  width: 100%;
}
</style>
