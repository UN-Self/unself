<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LogIn } from 'lucide-vue-next'
import { UButton, UCard, UErrorCard } from '@unself/ui'

/**
 * 登录页（#11，§6.5 动线）：
 * - 实例名 + 单按钮「使用工作账号登录」；无密码框（密码永远发生在 OIDC 提供方页面）
 * - 点击整页跳 OIDC（/api/auth/login?next=…）；state/PKCE 失败等错误显示人话
 * - 登录后落地：next 回原目标（#12 工作台消费），直访落第一个启用模块
 */

const route = useRoute()
const router = useRouter()

const instanceName = 'Unself 工作台'
const redirecting = ref(false)
// OIDC 回跳失败（callback 带错误参数）时展示人话；不暴露原始报错
const loginBroken = ref(false)

onMounted(() => {
  // core-api callback 失败时不会回本页（服务端直接报错），
  // 这里兜底处理路由携带 error 参数的形态（如 IdP 端直接回跳）。
  const err = route.query.error
  if (typeof err === 'string' && err.length > 0) {
    loginBroken.value = true
  }
})

function startLogin() {
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
        <p class="login-subtitle">使用团队统一账号登录，密码在身份源页面输入。</p>

        <UErrorCard
          v-if="loginBroken"
          class="login-error"
          title="登录暂时不可用"
          message="登录校验失败，请联系管理员检查身份源配置。"
          retry-label="重新登录"
          @retry="startLogin"
        />

        <UButton size="lg" class="login-button" :disabled="redirecting" @click="startLogin">
          <LogIn :size="18" aria-hidden="true" />
          使用工作账号登录
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
  padding: var(--space-4);
  background: var(--color-surface);
}
.login-card {
  width: 100%;
  max-width: 380px;
}
.login-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  text-align: center;
}
.login-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--color-text);
}
.login-subtitle {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
.login-error {
  width: 100%;
}
.login-button {
  width: 100%;
}
</style>
