<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Check, KeyRound, Plug, PlugZap, UserRound } from 'lucide-vue-next'
import { UButton, UInput, UCard, UErrorCard, UFlipCard } from '@unself/ui'
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
 * - OIDC 页：测试连接 → 保存配置 → 翻页回账号页；创建按钮独立在卡片外
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
const face = ref<'admin' | 'oidc'>('admin')
const adminFormId = `setup-admin-${useId()}`
const adminForm = ref<HTMLFormElement | null>(null)
const oidcForm = ref<HTMLFormElement | null>(null)
const setupShell = ref<HTMLElement | null>(null)
const announcement = ref('')

// 表单三字段（§6.5）
const issuer = ref('')
const clientId = ref('')
const clientSecret = ref('')
const fieldErrors = ref<{ issuer?: string; clientId?: string; clientSecret?: string }>({})
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)
const savingOidc = ref(false)
const oidcSaveError = ref<ApiError | null>(null)
const oidcSaved = ref(false)
const oidcDirty = ref(false)
const oidcState = computed(() => oidcDirty.value ? '待保存' : oidcSaved.value ? '已配置' : '可选')

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
  oidcDirty.value = true
  announcement.value = ''
  if (verified.value) {
    verified.value = false
    testResult.value = null
  }
})

/** 翻页只改变编辑位置；两页的输入始终保留，焦点不能留在未显示的那页。 */
async function flipTo(nextFace: 'admin' | 'oidc', focusCreate = false) {
  const active = document.activeElement
  if (active instanceof HTMLElement && setupShell.value?.contains(active)) active.blur()
  face.value = nextFace
  await nextTick()
  const target = focusCreate
    ? setupShell.value?.querySelector<HTMLElement>('[data-testid="create-admin"]')
    : nextFace === 'oidc'
      ? oidcForm.value?.querySelector<HTMLElement>('input')
      : setupShell.value?.querySelector<HTMLElement>('[data-testid="open-oidc"]')
  target?.focus({ preventScroll: true })
}

function openOidc() {
  if (!submitLocked.value) void flipTo('oidc')
}

function returnToAdmin() {
  if (face.value === 'oidc' && !submitting.value) void flipTo('admin')
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
  if (submitLocked.value || testing.value || face.value !== 'oidc') return
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
  if (submitLocked.value || face.value !== 'oidc') return
  oidcSaveError.value = null
  if (!validate() || !token.value || !verified.value) return
  const oidc = {
    issuer: issuer.value.trim(),
    clientId: clientId.value.trim(),
    clientSecret: clientSecret.value,
  }
  savingOidc.value = true
  let saved = false
  try {
    await saveOidcConfig(token.value, oidc)
    oidcSaved.value = true
    oidcDirty.value = false
    testResult.value = null
    announcement.value = 'OIDC 配置已保存'
    saved = true
  } catch (err) {
    oidcSaveError.value = err as ApiError
    // 边界语义 2：提交失败（网络/落库）→ 回「测试连接」可重测，不僵在 loading
    verified.value = false
    testResult.value = null
  } finally {
    savingOidc.value = false
  }
  if (saved) await flipTo('admin', true)
}

/** 账号页校验和 OIDC 页上的账号摘要共用同一份前端自查；服务端仍独立校验。 */
const adminValidation = computed(() => {
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
  return errors
})
const adminReady = computed(() => Object.keys(adminValidation.value).length === 0)

function validateAdmin(): boolean {
  adminFieldErrors.value = adminValidation.value
  return adminReady.value
}

/** 内置分支提交：建号封箱 → 直接登录拿会话 → 进工作台。token 随链接一起提交（#165）。 */
async function onCreateAdmin() {
  if (submitLocked.value || face.value !== 'admin') return
  adminError.value = ''
  if (!validateAdmin() || !token.value) {
    await nextTick()
    adminForm.value?.querySelector<HTMLElement>('input[aria-invalid="true"]')?.focus()
    return
  }
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
    <UCard v-if="phase === 'no-token'" padding="lg" class="setup-tokenless">
      <KeyRound :size="28" aria-hidden="true" class="setup-tokenless-icon" />
      <h1 class="setup-title">需要初始化链接</h1>
      <p class="setup-desc">
        请使用部署时输出的完整初始化链接（<code>/setup?token=…</code>）配置实例。
      </p>
    </UCard>

    <section v-else ref="setupShell" class="setup-shell" @keydown.esc="returnToAdmin">
      <UFlipCard :flipped="face === 'oidc'">
        <template #corner>
          <UButton
            variant="ghost"
            class="setup-fold"
            data-testid="open-oidc"
            :aria-label="`OIDC（${oidcState}），翻到配置面`"
            :disabled="submitLocked"
            @click="openOidc"
          />
        </template>
        <template #front>
          <div class="setup-face-body">
            <h1 class="setup-title setup-front-title">配置你的工作台</h1>
            <form
              :id="adminFormId"
              ref="adminForm"
              class="setup-form"
              data-testid="admin-form"
              novalidate
              @submit.prevent="onCreateAdmin"
            >
              <h2 class="setup-section-title">管理员账号</h2>
              <p v-if="adminError" class="setup-inline-error" role="alert">{{ adminError }}</p>
              <UInput
                v-model="adminUsername"
                label="用户名"
                name="username"
                autocomplete="username"
                placeholder="请输入用户名"
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
                placeholder="请输入密码"
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
                placeholder="请再次输入密码"
                autocomplete="new-password"
                required
                :disabled="submitLocked"
                :error="adminFieldErrors.passwordConfirm ?? false"
                reserve-error-line
              />
            </form>
          </div>
        </template>

        <template #back>
          <div class="setup-face-body">
            <!-- 这是实际 OIDC 页的一部分，账号页折角直接露出同一个标识。 -->
            <div class="setup-oidc-identity">
              <Check
                v-if="oidcSaved && !oidcDirty"
                :size="18"
                aria-hidden="true"
                class="setup-success setup-oidc-mark"
              />
              <Plug v-else :size="18" aria-hidden="true" class="setup-oidc-mark" />
              <span>OIDC</span>
              <span>{{ oidcState === '可选' ? '（可选）' : oidcState }}</span>
            </div>
            <UButton
              variant="ghost"
              size="sm"
              class="setup-return"
              data-testid="return-admin"
              :disabled="submitting"
              @click="returnToAdmin"
            >
              <ArrowLeft :size="16" aria-hidden="true" />
              返回账号
            </UButton>
            <h1 class="setup-title setup-back-title">OIDC 设置</h1>
            <div class="setup-account-summary">
              <div class="setup-account-state">
                <UserRound :size="18" aria-hidden="true" />
                <span class="setup-account-name">{{ adminUsername.trim() || '管理员账号' }}</span>
                <span :class="{ 'setup-success': adminReady }">{{ adminReady ? '已填写' : '待完善' }}</span>
                <Check v-if="adminReady" :size="16" aria-hidden="true" class="setup-success" />
              </div>
            </div>
            <UErrorCard
              v-if="oidcSaveError"
              title="OIDC 配置没有完成"
              :message="oidcSaveError.message"
              :request-id="oidcSaveError.requestId"
              :detail="oidcSaveError.detail"
            />
            <form
              ref="oidcForm"
              class="setup-form setup-oidc-form"
              data-testid="oidc-form"
              novalidate
              @submit.prevent="onSaveOidcConfig"
            >
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
                placeholder="请输入 Client ID"
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
                placeholder="请输入 Client Secret"
                autocomplete="off"
                required
                :disabled="submitLocked"
                :error="fieldErrors.clientSecret ?? false"
                reserve-error-line
              />
              <div class="setup-oidc-actions">
                <p
                  v-if="testResult"
                  class="setup-test-result"
                  :class="testResult.ok ? 'setup-success' : 'setup-inline-error'"
                  role="status"
                >
                  <Check v-if="testResult.ok" :size="16" aria-hidden="true" />
                  {{ testResult.text }}
                </p>
                <UButton
                  v-if="!verified"
                  data-testid="oidc-test"
                  variant="outline"
                  class="setup-oidc-action"
                  :loading="testing"
                  :disabled="submitLocked"
                  @click="onTestConnection"
                >
                  <PlugZap :size="16" aria-hidden="true" />
                  测试连接
                </UButton>
                <UButton
                  v-else
                  data-testid="oidc-save"
                  type="submit"
                  variant="outline"
                  class="setup-oidc-action"
                  :loading="savingOidc"
                  :disabled="submitLocked"
                >
                  保存配置
                </UButton>
              </div>
            </form>
          </div>
        </template>
      </UFlipCard>

      <UErrorCard
        v-if="loginError"
        data-testid="admin-login-error"
        title="管理员账号已创建"
        :message="`${loginError}。请使用刚设置的本地管理员账号登录，无需重复创建。`"
        retry-label="使用本地管理员登录"
        @retry="onLoginCreatedAdmin"
      />
      <UButton
        type="submit"
        :form="adminFormId"
        size="lg"
        class="setup-create"
        data-testid="create-admin"
        :loading="creatingAdmin"
        :disabled="submitLocked || face === 'oidc'"
      >
        <KeyRound :size="18" aria-hidden="true" />
        创建并进入工作台
      </UButton>
      <p class="setup-announcement setup-success" role="status" aria-live="polite">{{ announcement }}</p>
    </section>
  </main>
</template>

<style scoped>
.setup-page {
  display: grid;
  min-height: 100svh;
  place-items: center;
  padding: var(--unself-space-8);
  background: var(--unself-color-bg);
}
.setup-shell,
.setup-tokenless {
  width: 100%;
  max-width: calc(var(--unself-space-8) * 16);
  min-width: 0;
}
.setup-shell {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-5);
}
.setup-tokenless {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-4);
  text-align: center;
}
.setup-tokenless-icon {
  color: var(--unself-color-primary);
}
.setup-face-body {
  position: relative;
  height: 100%;
  padding: var(--unself-space-8);
}
.setup-title {
  margin: 0;
  font-size: var(--unself-font-size-2xl);
  font-weight: 600;
  line-height: 1.4;
  color: var(--unself-color-text);
}
.setup-front-title {
  padding-right: calc(var(--unself-space-8) * 2);
  margin-bottom: var(--unself-space-8);
}
.setup-back-title {
  margin: var(--unself-space-4) 0;
}
.setup-desc {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.setup-form {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}
.setup-section-title {
  margin: 0 0 var(--unself-space-3);
  font-size: var(--unself-font-size-xl);
  font-weight: 600;
  color: var(--unself-color-text);
}
.setup-fold {
  position: absolute;
  top: 0;
  right: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border-radius: 0 var(--unself-radius-lg) 0 0;
  background: transparent;
  isolation: isolate;
  color: var(--unself-color-text);
  transition: color var(--unself-duration-fast) var(--unself-ease-out);
}
/* 折页是卡片的一部分，按下时不能继承普通按钮的整体缩放。 */
.setup-fold.u-btn:active:not(:disabled) {
  transform: none;
  background: transparent;
}
.setup-oidc-identity {
  position: absolute;
  /* 整组文案留在斜折线右上方的安全区，不靠盖住折线掩饰相交。 */
  z-index: 1;
  top: var(--unself-space-2);
  right: var(--unself-space-2);
  width: calc(var(--unself-space-8) * 1.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-1);
  padding: 0;
  font-size: var(--unself-font-size-xs);
  line-height: 1.1;
  white-space: nowrap;
  /* 压印一档墨色（渐变浅端 4.8:1，仍过 AA）；凹槽由字形自身的上暗下亮给出，不用位移阴影（位移 = 重影）。 */
  color: var(--unself-color-text-secondary);
}
/* 上壁背光、下壁接光（光从上方来）：上深下浅，字形读成压进卡面的一道刻痕，下端融回卡面。 */
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .setup-oidc-identity span {
    background-image: linear-gradient(
      to bottom,
      var(--unself-color-text),
      var(--unself-color-text-secondary)
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
}
/* 图标与文字同一次冲压：SVG 描边吃不到字内渐变，改用同一套「上实下虚」的 α 遮罩；
   遮罩不生效只是平涂，不会像 url(#) 引用那样把图标弄丢。 */
.setup-oidc-mark {
  -webkit-mask-image: linear-gradient(to bottom, currentColor, color-mix(in srgb, currentColor 60%, transparent));
  mask-image: linear-gradient(to bottom, currentColor, color-mix(in srgb, currentColor 60%, transparent));
}
.setup-oidc-identity > svg:not(.setup-success) {
  /* 与文字渐变上端同档；已保存的绿勾保留状态色 */
  color: var(--unself-color-text);
}
.setup-fold:focus-visible {
  outline-offset: calc(-1 * var(--unself-space-1));
}
@media (hover: hover) {
  .setup-fold.u-btn:hover:not(:disabled) {
    background: transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .setup-fold {
    transition: none;
  }
}
.setup-account-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--unself-space-2);
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface-active);
  margin-bottom: var(--unself-space-6);
}
.setup-account-state {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  min-width: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.setup-account-name {
  max-width: calc(var(--unself-space-8) * 4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--unself-color-text);
}
.setup-return {
  display: flex;
  width: max-content;
  min-height: var(--unself-touch-target);
  padding: 0;
  color: var(--unself-color-primary);
}
.setup-inline-error {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-danger);
}
.setup-oidc-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--unself-space-3);
  min-height: var(--unself-touch-target);
}
.setup-oidc-action {
  min-width: calc(var(--unself-space-8) * 4);
  min-height: var(--unself-touch-target);
}
.setup-test-result {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
  flex: 1 1 0;
  min-width: calc(var(--unself-space-8) * 4);
  overflow-wrap: anywhere;
  margin: 0;
  font-size: var(--unself-font-size-sm);
}
.setup-create {
  width: 100%;
  min-height: calc(var(--unself-touch-target) + var(--unself-space-2));
}
.setup-success {
  color: var(--unself-color-success);
}
.setup-announcement {
  min-height: calc(var(--unself-font-size-sm) * 1.5);
  margin: calc(-1 * var(--unself-space-3)) 0 0;
  text-align: center;
  font-size: var(--unself-font-size-sm);
}
@media (max-width: 480px) {
  .setup-page {
    padding: var(--unself-space-4);
  }
  .setup-face-body {
    padding: var(--unself-space-5);
  }
  .setup-title {
    font-size: var(--unself-font-size-xl);
  }
  .setup-front-title {
    margin-bottom: var(--unself-space-8);
  }
  .setup-account-summary {
    padding: var(--unself-space-2);
  }
  .setup-account-name {
    max-width: calc(var(--unself-space-8) * 3);
  }
}
</style>
