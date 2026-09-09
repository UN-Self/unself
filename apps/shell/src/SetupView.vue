<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KeyRound, PlugZap } from 'lucide-vue-next'
import { UButton, UInput, UCard, UErrorCard } from '@unself/ui'
import {
  activateSetup,
  saveOidcConfig,
  testOidcConnection,
  type ApiError,
} from './lib/setup-api'

/**
 * setup 向导页（#10，直线流程 #55，§6.5 动线）：
 * - 仅携带部署输出的一次性令牌才可配置；无令牌只提示
 * - 三字段（issuer / client id / client secret）+ 测试连接
 * - [保存并激活] → 配置落库后整页跳 OIDC → 回来自动提权成首个管理员 → 直接进工作台
 * - 回跳时 onMounted 先探 /api/me：已登录 → 自动调 activateSetup 提权
 *   （成功 router.replace('/')，403/409 等失败落错误卡）；未登录 → 静默停在表单
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

// #92 三态机：测试通过才显示「保存并激活」（同位置替换，不并排）
const verified = ref(false)

// 边界语义 1：测试通过后改任意字段 → 测试结果失效 → 按钮回「测试连接」
watch([issuer, clientId, clientSecret], () => {
  if (verified.value) {
    verified.value = false
    testResult.value = null
  }
})

onMounted(() => {
  const t = token.value
  if (t) void autoActivateIfAuthed(t)
})

/**
 * 直线流程收尾：登录回跳（next=/setup?token=…）后探测会话；
 * 已登录 → 自动提权：成功进工作台，403/409 等失败落错误卡；未登录/网络异常 → 静默停在表单。
 */
async function autoActivateIfAuthed(t: string) {
  let me: Response
  try {
    me = await fetch('/api/me', { credentials: 'same-origin' })
  } catch {
    return // 网络异常：不打扰，用户仍可填写提交
  }
  if (!me.ok) return // 未登录：等用户提交后走登录
  activating.value = true
  try {
    await activateSetup(t)
    await router.replace('/')
  } catch (err) {
    activateError.value = err as ApiError
  } finally {
    activating.value = false
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
  const tested = {
    issuer: issuer.value.trim(),
    clientId: clientId.value.trim(),
    clientSecret: clientSecret.value,
  }
  testing.value = true
  const result = await testOidcConnection(tested.issuer)
  testing.value = false
  // 竞态面（边界语义 1）：测试在途时用户改任意字段 → 结果作废，不回「保存并激活」
  if (
    issuer.value.trim() !== tested.issuer ||
    clientId.value.trim() !== tested.clientId ||
    clientSecret.value !== tested.clientSecret
  ) {
    return
  }
  verified.value = result.ok
  testResult.value = result.ok
    ? { ok: true, text: `连接成功：${result.issuer}` }
    : { ok: false, text: result.reason }
}

async function onSaveAndActivate() {
  activateError.value = null
  if (!validate() || !token.value) return
  // 直线流程（#55）：三字段先落库（oidc-config），不带 scope；成功后整页跳 IdP 登录
  const oidc = {
    issuer: issuer.value.trim(),
    clientId: clientId.value.trim(),
    clientSecret: clientSecret.value,
  }
  activating.value = true
  try {
    const result = await saveOidcConfig(token.value, oidc)
    // 配置已在服务端落库：跳 IdP 登录，next 带回 token，回来自动提权（onMounted）
    window.location.assign(result.loginUrl)
    return
  } catch (err) {
    activateError.value = err as ApiError
    // 边界语义 2：提交失败（网络/落库）→ 回「测试连接」可重测，不僵在 loading
    verified.value = false
    testResult.value = null
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

        <!-- #92：单按钮三态机——同一位置两态互斥，Vue <Transition> 默认淡入淡出过渡（§6.5 动效归模块自治，不移植 beUI StatefulButton） -->
        <div class="setup-test">
          <Transition name="setup-swap" mode="out-in">
            <UButton
              v-if="!verified"
              key="setup-test-connection"
              variant="outline"
              :loading="testing"
              @click="onTestConnection"
            >
              <PlugZap :size="16" aria-hidden="true" />
              测试连接
            </UButton>
            <UButton
              v-else
              key="setup-save-activate"
              type="submit"
              size="lg"
              class="setup-submit"
              :loading="activating"
            >
              保存并激活
            </UButton>
          </Transition>
          <span
            v-if="testResult"
            class="setup-test-result"
            :class="testResult.ok ? 'setup-test-ok' : 'setup-test-fail'"
            role="status"
          >
            {{ testResult.text }}
          </span>
        </div>
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
  padding: var(--unself-space-4);
  background: var(--unself-color-surface);
}
.setup-card {
  width: 100%;
  max-width: 420px;
}
.setup-tokenless {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-3);
  text-align: center;
  padding: var(--unself-space-6) 0;
}
.setup-tokenless-icon {
  color: var(--unself-color-text-tertiary);
}
.setup-title {
  margin: 0;
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.setup-desc {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.setup-error {
  margin-bottom: var(--unself-space-4);
}
.setup-form {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
  margin-top: var(--unself-space-4);
}
.setup-test {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  flex-wrap: wrap;
}
.setup-test-result {
  font-size: var(--unself-font-size-sm);
}
.setup-test-ok {
  color: var(--unself-color-success);
}
.setup-test-fail {
  color: var(--unself-color-danger);
}
.setup-submit {
  width: 100%;
}
/* #92 同位置替换过渡：时长/缓动取 tokens（§6.5 无外部动效库） */
.setup-swap-enter-active,
.setup-swap-leave-active {
  transition: opacity var(--unself-duration-fast) var(--unself-ease-out);
}
.setup-swap-enter-from,
.setup-swap-leave-to {
  opacity: 0;
}
.setup-note {
  margin: 0;
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
  text-align: center;
}
</style>
