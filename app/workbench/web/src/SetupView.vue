<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Check, KeyRound, PlugZap, UserPlus } from 'lucide-vue-next'
import { UButton, UInput, UCard, UErrorCard } from '@unself/ui'
import {
  saveOidcConfig,
  testOidcConnection,
  type ApiError,
} from './lib/setup-api'
import { createBuiltinAdmin, loginWithPassword, type AuthError } from './lib/builtin-auth-api'

/**
 * setup 向导页（#332：本地管理员必建，OIDC 为可选登录方式）：
 * - 仅携带部署输出的一次性令牌才可配置；无令牌只提示
 * - 默认分支「设置管理员账号」：用户名+密码+重复 → 建号封箱 → 直接登录进工作台
 * - OIDC 折叠分支：测试连接 → 保存配置，留在本页继续设置管理员
 * - 打开页面不自动消费 setup token 或提升当前账号权限
 */

const route = useRoute()
const router = useRouter()

type Phase = 'no-token' | 'ready'

const token = computed(() => {
  const raw = route.query.token
  return typeof raw === 'string' && raw.length > 0 ? raw : null
})

// #83：初始化状态由守卫决断（已完成 → 重定向离场），本页只按 token 分派文案
const phase = ref<Phase>(token.value ? 'ready' : 'no-token')

// 表单三字段（§6.5）
const issuer = ref('')
const clientId = ref('')
const clientSecret = ref('')
const fieldErrors = ref<{ issuer?: string; clientId?: string; clientSecret?: string }>({})
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)
const savingOidc = ref(false)
const oidcSaveError = ref<ApiError | null>(null)

// 内置管理员表单（issue-A 默认分支）
const adminUsername = ref('')
const adminPassword = ref('')
const adminPasswordConfirm = ref('')
const adminFieldErrors = ref<{ username?: string; password?: string; passwordConfirm?: string }>({})
const creatingAdmin = ref(false)
const adminError = ref('')
const adminCreated = ref(false)
const loginError = ref('')
const submitting = computed(() => creatingAdmin.value || savingOidc.value)
const submitLocked = computed(() => submitting.value || adminCreated.value)

// #92 三态机：测试通过才显示「保存配置」（同位置替换，不并排）
const verified = ref(false)

// 边界语义 1：测试通过后改任意字段 → 测试结果失效 → 按钮回「测试连接」
watch([issuer, clientId, clientSecret], () => {
  if (verified.value) {
    verified.value = false
    testResult.value = null
  }
})

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
  if (submitLocked.value || testing.value) return
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
  // 竞态面（边界语义 1）：测试在途时用户改任意字段 → 结果作废，不回「保存配置」
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

async function onSaveOidcConfig() {
  if (submitLocked.value) return
  oidcSaveError.value = null
  if (!validate() || !token.value || !verified.value) return
  const oidc = {
    issuer: issuer.value.trim(),
    clientId: clientId.value.trim(),
    clientSecret: clientSecret.value,
  }
  savingOidc.value = true
  try {
    await saveOidcConfig(token.value, oidc)
    testResult.value = { ok: true, text: 'OIDC 配置已保存' }
  } catch (err) {
    oidcSaveError.value = err as ApiError
    // 边界语义 2：提交失败（网络/落库）→ 回「测试连接」可重测，不僵在 loading
    verified.value = false
    testResult.value = null
  } finally {
    savingOidc.value = false
  }
}

/** 内置管理员表单校验（issue-A）：只做前端自查，格式与后端同口径。 */
function validateAdmin(): boolean {
  const errors: typeof adminFieldErrors.value = {}
  const username = adminUsername.value.trim()
  if (username.length === 0) {
    errors.username = '请填写用户名'
  } else if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    errors.username = '用户名需为 3-32 位字母/数字/_/-'
  }
  if (adminPassword.value.length < 8) {
    errors.password = '密码长度至少 8 位'
  }
  if (adminPasswordConfirm.value !== adminPassword.value || adminPasswordConfirm.value.length === 0) {
    errors.passwordConfirm = '两次输入的密码不一致'
  }
  adminFieldErrors.value = errors
  return Object.keys(errors).length === 0
}

/** 内置分支提交：建号封箱 → 直接登录拿会话 → 进工作台。token 随链接一起提交（#165）。 */
async function onCreateAdmin() {
  if (submitLocked.value) return
  adminError.value = ''
  if (!validateAdmin() || !token.value) return
  const username = adminUsername.value.trim()
  creatingAdmin.value = true
  try {
    await createBuiltinAdmin(token.value, username, adminPassword.value)
    adminCreated.value = true
    await loginWithPassword(username, adminPassword.value)
    await router.replace('/')
  } catch (err) {
    if (adminCreated.value) {
      loginError.value = (err as AuthError).message
    } else {
      adminError.value = (err as AuthError).message
    }
  } finally {
    creatingAdmin.value = false
  }
}

/** 建号已成功时只重试登录，不再提交 setup token。 */
async function onLoginCreatedAdmin() {
  if (submitting.value || !adminCreated.value) return
  creatingAdmin.value = true
  try {
    await loginWithPassword(adminUsername.value.trim(), adminPassword.value)
    await router.replace('/')
  } catch (err) {
    loginError.value = (err as AuthError).message
  } finally {
    creatingAdmin.value = false
  }
}
</script>

<template>
  <main class="setup-page">
    <UCard v-if="phase === 'no-token'" padding="lg" class="setup-card">
      <div class="setup-tokenless">
        <KeyRound :size="28" aria-hidden="true" class="setup-tokenless-icon" />
        <h1 class="setup-title">需要初始化链接</h1>
        <p class="setup-desc">
          本页面仅能通过部署时输出的初始化链接访问。请向部署者索取一次性初始化链接
          （形如 <code>/setup?token=…</code>），打开后即可完成实例配置。
        </p>
      </div>
    </UCard>

    <UCard v-else padding="lg" class="setup-card">
      <h1 class="setup-title">配置你的工作台</h1>

      <UErrorCard
        v-if="loginError"
        data-testid="admin-login-error"
        class="setup-error"
        title="管理员账号已创建"
        :message="`${loginError}。请使用刚设置的本地管理员账号登录，无需重复创建。`"
        retry-label="使用本地管理员登录"
        @retry="onLoginCreatedAdmin"
      />

      <UErrorCard
        v-if="oidcSaveError"
        class="setup-error"
        title="OIDC 配置没有完成"
        :message="oidcSaveError.message"
        :request-id="oidcSaveError.requestId"
        :detail="oidcSaveError.detail"
      />

      <!-- 内置分支（issue-A 默认）：管理员账号三字段 -->
      <form class="setup-form" data-testid="admin-form" novalidate @submit.prevent="onCreateAdmin">
        <div class="setup-branch-head">
          <UserPlus :size="18" aria-hidden="true" class="setup-branch-icon" />
          <span class="setup-branch-title">设置管理员账号</span>
        </div>
        <p v-if="adminError" class="setup-inline-error" role="alert">{{ adminError }}</p>
        <UInput
          v-model="adminUsername"
          label="用户名"
          name="username"
          autocomplete="username"
          placeholder="3-32 位字母/数字/_/-"
          required
          :disabled="submitLocked"
          :error="adminFieldErrors.username ?? false"
          reserve-error-line
        />
        <UInput
          v-model="adminPassword"
          label="密码"
          type="password"
          name="password"
          autocomplete="new-password"
          required
          :disabled="submitLocked"
          :error="adminFieldErrors.password ?? false"
          reserve-error-line
        />
        <UInput
          v-model="adminPasswordConfirm"
          label="重复密码"
          type="password"
          name="password_confirm"
          autocomplete="new-password"
          required
          :disabled="submitLocked"
          :error="adminFieldErrors.passwordConfirm ?? false"
          reserve-error-line
        />
        <UButton type="submit" size="lg" class="setup-action" :loading="creatingAdmin" :disabled="submitLocked">
          <KeyRound :size="16" aria-hidden="true" />
          创建并进入工作台
        </UButton>
      </form>

      <!-- OIDC 分支收进折叠项（可选增强，SPEC 决策 20） -->
      <details class="setup-oidc-toggle">
        <summary class="setup-oidc-summary">OIDC（可选）</summary>
        <form class="setup-form" data-testid="oidc-form" novalidate @submit.prevent="onSaveOidcConfig">
        <UInput
          v-model="issuer"
          label="OIDC Issuer 地址"
          type="url"
          name="issuer"
          placeholder="https://idp.example.com"
          autocomplete="url"
          required
          :disabled="submitLocked"
          :error="fieldErrors.issuer ?? false"
          reserve-error-line
        />
        <UInput
          v-model="clientId"
          label="Client ID"
          name="client_id"
          autocomplete="off"
          required
          :disabled="submitLocked"
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
          :disabled="submitLocked"
          :error="fieldErrors.clientSecret ?? false"
          reserve-error-line
        />

        <!-- #92：测试连接与保存配置同位置互斥；两态均为次要操作。 -->
        <div class="setup-test">
          <div class="setup-test-stage">
            <Transition name="setup-swap" mode="out-in">
              <UButton
                v-if="!verified"
                key="setup-test-connection"
                data-testid="oidc-test"
                variant="outline"
                class="setup-action"
                :loading="testing"
                :disabled="submitLocked"
                @click="onTestConnection"
              >
                <PlugZap :size="16" aria-hidden="true" />
                测试连接
              </UButton>
              <UButton
                v-else
                key="setup-save-config"
                data-testid="oidc-save"
                type="submit"
                variant="outline"
                size="lg"
                class="setup-action"
                :loading="savingOidc"
                :disabled="submitLocked"
              >
                <Check :size="16" aria-hidden="true" class="setup-check-icon" />
                保存配置
              </UButton>
            </Transition>
          </div>
          <p
            v-if="testResult"
            class="setup-test-result"
            :class="testResult.ok ? 'setup-test-ok' : 'setup-test-fail'"
            role="status"
          >
            {{ testResult.text }}
          </p>
        </div>
        </form>
      </details>
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
.setup-branch-head {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.setup-branch-icon {
  color: var(--unself-color-primary);
}
.setup-branch-title {
  font-size: var(--unself-font-size-base);
  font-weight: 600;
  color: var(--unself-color-text);
}
.setup-inline-error {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-danger);
}
.setup-oidc-toggle {
  margin-top: var(--unself-space-5);
  border-top: 1px solid var(--unself-color-border);
  padding-top: var(--unself-space-4);
}
.setup-oidc-summary {
  cursor: pointer;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  user-select: none;
}
.setup-form {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
  margin-top: var(--unself-space-4);
}
.setup-test {
  display: flex;
  flex-direction: column; /* #95：按钮行 + 结果行纵向排布，结果文字在按钮下方 */
  align-items: center;
  gap: var(--unself-space-3);
}
/* #95 同宽收口：两态按钮都 width:100% 居中（初始态「测试连接」不再内容宽度居左） */
.setup-test-stage {
  width: 100%;
  display: flex;
  justify-content: center;
}
.setup-action {
  width: 100%;
}
.setup-test-result {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  text-align: center;
}
.setup-test-ok {
  color: var(--unself-color-success);
}
.setup-test-fail {
  color: var(--unself-color-danger);
}
/*
 * #95 换位动效：参数照抄 beUI StatefulButton
 * （github.com/starc007/ui-components · lib/ease.ts · SPRING_SWAP）。
 *
 * SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 }
 * 无 React 动效库，弹簧以 CSS linear() 等价采样（framer-motion 同参数解析式
 * x(t) = 1 − e^(−ζω₀t)·(cos ω_d·t + (ζω₀/ω_d)·sin ω_d·t)，ζω₀ = c/2m = 27.273，
 * ω_d = √(k/m − (c/2m)²) = 9.621；约 210ms 内入 1% 带内，非欠阻尼无回弹）。
 * 时长取 tokens --duration-normal（250ms，覆盖弹簧整段），
 * 缓动 = SPRING_SWAP 采样曲线（动效不属契约 §6.5.2，不新增语义令牌）。
 */
.setup-swap-enter-active {
  transition:
    opacity var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-normal) linear(
      0, 0.035 4%, 0.117 8%, 0.221 12%, 0.331 16%, 0.438 20%, 0.536 24%,
      0.622 28%, 0.696 32%, 0.759 36%, 0.811 40%, 0.853 44%, 0.886 48%,
      0.913 52%, 0.934 56%, 0.951 60%, 0.964 64%, 0.973 68%, 0.981 72%,
      0.986 76%, 0.99 80%, 0.993 84%, 0.995 88%, 0.997 92%, 0.998 96%, 1
    );
}
.setup-swap-leave-active {
  transition:
    opacity var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-out);
}
.setup-swap-enter-from,
.setup-swap-leave-to {
  opacity: 0;
  transform: translateY(14px); /* beUI TextSlot：入从下 14px，出向上离场 */
}
.setup-swap-leave-to {
  transform: translateY(-14px);
}
/*
 * 图标弹性缩放滑入（照抄 beUI ICON_VARIANTS：scale 0.7→1 + 淡入），
 * 弹簧参数同 SPRING_SWAP；「保存配置」挂载时 Check 弹性出现。
 * prefers-reduced-motion：动效全部退化为纯淡入（beUI useReducedMotion 同语义）。
 */
.setup-check-icon {
  animation: setup-icon-spring var(--unself-duration-normal) linear(
    0, 0.035 4%, 0.117 8%, 0.221 12%, 0.331 16%, 0.438 20%, 0.536 24%,
    0.622 28%, 0.696 32%, 0.759 36%, 0.811 40%, 0.853 44%, 0.886 48%,
    0.913 52%, 0.934 56%, 0.951 60%, 0.964 64%, 0.973 68%, 0.981 72%,
    0.986 76%, 0.99 80%, 0.993 84%, 0.995 88%, 0.997 92%, 0.998 96%, 1
  ) both;
}
@keyframes setup-icon-spring {
  from {
    opacity: 0;
    transform: scale(0.7);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .setup-swap-enter-active,
  .setup-swap-leave-active {
    transition: opacity var(--unself-duration-fast) linear;
  }
  .setup-swap-enter-from,
  .setup-swap-leave-to {
    transform: none;
  }
  .setup-check-icon {
    animation: none;
  }
}
</style>
