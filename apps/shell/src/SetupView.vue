<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyRound, PlugZap } from 'lucide-vue-next'
import { UButton, UInput, UCard, UErrorCard } from '@unself/ui'
import {
  activateOrLogin,
  testOidcConnection,
  type ApiError,
} from './lib/setup-api'

/**
 * setup 向导页（#10，§6.5 动线）：
 * - 仅携带部署输出的一次性令牌才可配置；无令牌只提示
 * - 三字段（issuer / client id / client secret）+ 测试连接
 * - [保存并激活] → 整页跳 OIDC → 回来自动成管理员 → 直接进工作台
 * - 已激活后本页不存在：已登录→工作台，未登录→登录页（#83：只信路由守卫，
 *   页面不再自行判定 getSetupStatus + /api/me + router.replace）
 */

const route = useRoute()
const router = useRouter()

type Phase = 'no-token' | 'ready'

const token = computed(() => {
  const raw = route.query.token
  return typeof raw === 'string' && raw.length > 0 ? raw : null
})

// #83：激活态由守卫决断（已完成 → 重定向离场），本页只按 token 分派文案
const phase = ref<Phase>(token.value ? 'ready' : 'no-token')

// 表单三字段（§6.5）
const issuer = ref('')
const clientId = ref('')
const clientSecret = ref('')
const fieldErrors = ref<{ issuer?: string; clientId?: string; clientSecret?: string }>({})
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)
const activating = ref(false)
const activateError = ref<ApiError | null>(null)
// 跳登录前把表单（不含 secret）侧记到 sessionStorage，登录回来字段为空时恢复
const OIDC_DRAFT_KEY = 'unself_setup_oidc'

onMounted(() => {
  // 激活态判定已上移路由守卫（#83）：此处只恢复表单草稿
  restoreOidcDraft()
})

/** 恢复跳登录前侧记的 issuer/clientId（secret 从不持久化）。 */
function restoreOidcDraft() {
  try {
    const raw = sessionStorage.getItem(OIDC_DRAFT_KEY)
    if (!raw) return
    const draft = JSON.parse(raw) as { issuer?: unknown; clientId?: unknown }
    if (issuer.value === '' && typeof draft.issuer === 'string') issuer.value = draft.issuer
    if (clientId.value === '' && typeof draft.clientId === 'string') clientId.value = draft.clientId
  } catch {
    // 侧记数据损坏：忽略，用户重填
  }
}

function validate(): boolean {
  const errors: typeof fieldErrors.value = {}
  if (!/^https?:\/\//.test(issuer.value.trim())) {
    errors.issuer = '需要完整的 Issuer 地址（https://…）'
  }
  if (clientId.value.trim().length === 0) {
    errors.clientId = '请填写 Client ID'
  }
  if (clientSecret.value.length === 0) {
    errors.clientSecret = '请填写 Client Secret'
  }
  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

async function onTestConnection() {
  testResult.value = null
  if (!/^https?:\/\//.test(issuer.value.trim())) {
    fieldErrors.value = { ...fieldErrors.value, issuer: '需要完整的 Issuer 地址（https://…）' }
    return
  }
  testing.value = true
  const result = await testOidcConnection(issuer.value.trim())
  testing.value = false
  testResult.value = result.ok
    ? { ok: true, text: `连接成功：${result.issuer}` }
    : { ok: false, text: result.reason }
}

async function onSaveAndActivate() {
  activateError.value = null
  if (!validate() || !token.value) return
  // 向导三字段（issuer/client id/secret + scope）随激活请求发给后端（#44）：
  // 后端持久化到 instance_config，登录链路不再退回 env 注入回退，此前缺发已落空修复。
  const oidc = {
    issuer: issuer.value.trim(),
    clientId: clientId.value.trim(),
    clientSecret: clientSecret.value,
    scope: 'openid profile email',
  }
  activating.value = true
  try {
    const result = await activateOrLogin(token.value, oidc)
    if ('needLogin' in result) {
      // 未登录：整页跳 OIDC，next 已带回 token；回来时激活态由路由守卫续判
      // 表单（除 secret）侧记到 sessionStorage，登录回来字段为空时恢复
      sessionStorage.setItem(
        OIDC_DRAFT_KEY,
        JSON.stringify({ issuer: oidc.issuer, clientId: oidc.clientId }),
      )
      window.location.assign(result.needLogin)
      return
    }
    // 激活成功：直接进工作台（不停留，§6.5），侧记的字段不再需要
    sessionStorage.removeItem(OIDC_DRAFT_KEY)
    await router.replace('/')
  } catch (err) {
    activateError.value = err as ApiError
  } finally {
    activating.value = false
  }
}
</script>

<template>
  <main class="setup-page">
    <UCard v-if="phase === 'no-token'" padding="lg" class="setup-card">
      <div class="setup-tokenless">
        <KeyRound :size="28" aria-hidden="true" class="setup-tokenless-icon" />
        <h1 class="setup-title">需要激活链接</h1>
        <p class="setup-desc">
          本页面仅能通过部署时输出的激活链接访问。请向部署者索取一次性激活链接
          （形如 <code>/setup?token=…</code>），打开后即可完成实例配置。
        </p>
      </div>
    </UCard>

    <UCard v-else padding="lg" class="setup-card">
      <h1 class="setup-title">配置你的工作台</h1>
      <p class="setup-desc">三步完成：填写身份源 → 测试连接 → 用工作账号登录激活。</p>

      <UErrorCard
        v-if="activateError"
        class="setup-error"
        title="激活没有成功"
        :message="activateError.message"
        :request-id="activateError.requestId"
        :detail="activateError.detail"
        retry-label="重试"
        @retry="onSaveAndActivate"
      />

      <form class="setup-form" @submit.prevent="onSaveAndActivate">
        <UInput
          v-model="issuer"
          label="OIDC Issuer 地址"
          type="url"
          name="issuer"
          placeholder="https://idp.example.com"
          autocomplete="url"
          required
          :error="fieldErrors.issuer ?? false"
          reserve-error-line
        />
        <UInput
          v-model="clientId"
          label="Client ID"
          name="client_id"
          autocomplete="off"
          required
          :error="fieldErrors.clientId ?? false"
          reserve-error-line
        />
        <UInput
          v-model="clientSecret"
          label="Client Secret"
          type="password"
          name="client_secret"
          autocomplete="off"
          required
          :error="fieldErrors.clientSecret ?? false"
          reserve-error-line
        />

        <div class="setup-test">
          <UButton variant="outline" :loading="testing" @click="onTestConnection">
            <PlugZap :size="16" aria-hidden="true" />
            测试连接
          </UButton>
          <span
            v-if="testResult"
            class="setup-test-result"
            :class="testResult.ok ? 'setup-test-ok' : 'setup-test-fail'"
            role="status"
          >
            {{ testResult.text }}
          </span>
        </div>

        <UButton
          type="submit"
          size="lg"
          class="setup-submit"
          :loading="activating"
        >
          保存并激活
        </UButton>
        <p class="setup-note">激活需要用工作账号登录；登录页面由你的身份源提供。</p>
      </form>
    </UCard>
  </main>
</template>

<style scoped>
.setup-page {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--color-surface);
}
.setup-card {
  width: 100%;
  max-width: 420px;
}
.setup-tokenless {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
  padding: var(--space-6) 0;
}
.setup-tokenless-icon {
  color: var(--color-text-tertiary);
}
.setup-title {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: 600;
  color: var(--color-text);
}
.setup-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
.setup-error {
  margin-bottom: var(--space-4);
}
.setup-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.setup-test {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.setup-test-result {
  font-size: var(--font-size-sm);
}
.setup-test-ok {
  color: var(--color-success);
}
.setup-test-fail {
  color: var(--color-danger);
}
.setup-submit {
  width: 100%;
}
.setup-note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  text-align: center;
}
</style>
