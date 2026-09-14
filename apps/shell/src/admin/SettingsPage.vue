<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { UButton, UCard, UErrorCard, UInput, USkeleton, USwitch } from '@unself/ui'

import {
  fetchSettings,
  saveSettings,
  SECRET_MASK,
  testMailConnection,
  type ApiError,
  type InstanceSettings,
  type MailTestResult,
} from '../lib/admin-api'
import { testOidcConnection } from '../lib/setup-api'
import { useAsyncLoad } from '../lib/use-async-load'

/**
 * 管理台设置页（#17）：OIDC 段 + mail 段查看/编辑 + 测试连接（含 warnings 黄牌）。
 * 密钥字段只写不读：服务端 GET 恒回 '***'，前端留空即不修改（不做客户端二次校验）。
 * 不做：DYN DNS、存储段、多套配置 profile。
 */

// #142：加载三态样板收编 use-async-load（phase/loadError 变量名不变，模板零改动）
const { phase, loadError, data: settings } = useAsyncLoad<InstanceSettings>(fetchSettings)

// 表单模型（密钥字段永远不回填真值，只显示占位与「已配置」提示）
const issuer = ref('')
const clientId = ref('')
const clientSecret = ref('')
const scope = ref('')
const baseUrl = ref('')
const apiKey = ref('')
const domain = ref('')
const host = ref('')
const port = ref('')
const username = ref('')
const password = ref('')
const from = ref('')

/** 已配置密钥的提示（GET 返回 '***' 即已配置）。 */
const oidcSecretConfigured = ref(false)
const apiKeyConfigured = ref(false)
const passwordConfigured = ref(false)

const saving = ref(false)
const testing = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
const testOk = ref<null | { warnings: string[] }>(null)
const testFailReason = ref<string | null>(null)

// 邮件测试状态（#139）：与 OIDC 测试的 testing/testFailReason 完全独立，
// 失败信息只渲染在邮件卡内，两个测试按钮互不干扰。
const mailTesting = ref(false)
const mailTestError = ref<string | null>(null)
const mailTest = ref<{ provisioner: MailTestResult; sender: MailTestResult } | null>(null)

// 邮件轴开关（P4/T3）：enabled 缺失的老数据后端视为 true，GET 恒回 boolean；
// mailConfigured = 任一文本字段非空或任一密钥已配置——无 mail 行时开关
// off + disabled（避免「开但无配置」状态）。
const mailEnabled = ref(true)
const mailConfigured = ref(false)

/** 有效轴状态：有配置且开关开着才算「轴开」；无配置时一切按关处理（折叠/测试禁用/开关 off）。 */
const mailAxisOn = computed(() => mailEnabled.value && mailConfigured.value)

// 数据就位 → 回填表单（含保存后无需重新拉取的既有行为）
watch(settings, (s) => { if (s) applyLoaded(s) }, { immediate: true })

function applyLoaded(s: InstanceSettings): void {
  issuer.value = s.oidc.issuer
  clientId.value = s.oidc.clientId
  scope.value = s.oidc.scope
  baseUrl.value = s.mail.baseUrl
  domain.value = s.mail.domain
  host.value = s.mail.host
  port.value = s.mail.port === '' ? '' : String(s.mail.port)
  username.value = s.mail.username
  from.value = s.mail.from
  oidcSecretConfigured.value = s.oidc.clientSecret === SECRET_MASK
  apiKeyConfigured.value = s.mail.apiKey === SECRET_MASK
  passwordConfigured.value = s.mail.password === SECRET_MASK
  mailEnabled.value = s.mail.enabled
  mailConfigured.value = Boolean(
    s.mail.baseUrl
    || s.mail.domain
    || s.mail.host
    || s.mail.port !== ''
    || s.mail.username
    || s.mail.from
    || s.mail.apiKey === SECRET_MASK
    || s.mail.password === SECRET_MASK,
  )
}

/** PUT body：只发有变化的字段；密钥只在填了新值（非空且非 ***）时发送。 */
function buildUpdate(): Parameters<typeof saveSettings>[0] {
  const oidc: Record<string, string> = {}
  if (issuer.value) oidc.issuer = issuer.value
  if (clientId.value) oidc.clientId = clientId.value
  if (scope.value) oidc.scope = scope.value
  if (clientSecret.value && clientSecret.value !== SECRET_MASK) oidc.clientSecret = clientSecret.value

  const mail: Record<string, string | number> = {}
  if (baseUrl.value) mail.baseUrl = baseUrl.value
  if (domain.value) mail.domain = domain.value
  if (host.value) mail.host = host.value
  if (port.value) mail.port = Number(port.value)
  if (username.value) mail.username = username.value
  if (from.value) mail.from = from.value
  if (apiKey.value && apiKey.value !== SECRET_MASK) mail.apiKey = apiKey.value
  if (password.value && password.value !== SECRET_MASK) mail.password = password.value

  return { oidc, mail }
}

async function onSave(): Promise<void> {
  saving.value = true
  saveError.value = null
  saved.value = false
  try {
    const update = buildUpdate()
    await saveSettings(update)
    saved.value = true
    // 首次保存即创建 mail 行：开关从「无配置」解锁（无需刷新页面）
    if (update.mail && Object.keys(update.mail).length > 0) mailConfigured.value = true
    // 密钥保存后清空输入（不回显真值），「已配置」提示翻转
    if (update.oidc?.clientSecret) oidcSecretConfigured.value = true
    if (update.mail?.apiKey) apiKeyConfigured.value = true
    if (update.mail?.password) passwordConfigured.value = true
    clientSecret.value = ''
    apiKey.value = ''
    password.value = ''
  } catch (err) {
    saveError.value = (err as ApiError).message
  } finally {
    saving.value = false
  }
}

/**
 * 邮件轴开关切换：乐观翻转 → 只 PUT mail.enabled（关≠清配置，服务端保留其余字段）；
 * 成功就地保持；失败回滚并沿用 saveError 提示位（不触发「已保存」文案）。
 */
async function onToggleMailEnabled(next: boolean): Promise<void> {
  mailEnabled.value = next
  saveError.value = null
  try {
    await saveSettings({ mail: { enabled: next } })
  } catch (err) {
    mailEnabled.value = !next
    saveError.value = (err as ApiError).message
  }
}

async function onTestMailConnection(): Promise<void> {
  mailTesting.value = true
  mailTestError.value = null
  mailTest.value = null
  try {
    mailTest.value = await testMailConnection()
  } catch (err) {
    mailTestError.value = (err as ApiError).message
  } finally {
    mailTesting.value = false
  }
}

async function onTestConnection(): Promise<void> {
  testing.value = true
  testOk.value = null
  testFailReason.value = null
  const result = await testOidcConnection(issuer.value)
  if (result.ok) {
    testOk.value = { warnings: result.warnings }
  } else {
    testFailReason.value = result.reason
  }
  testing.value = false
}
</script>

<template>
  <div>
    <h1 class="page-title">设置</h1>

    <USkeleton v-if="phase === 'loading'" class="page-skeleton" />

    <UErrorCard
      v-else-if="phase === 'error'"
      title="设置加载失败"
      :message="loadError?.message"
      :request-id="loadError?.requestId"
      :detail="loadError?.detail"
    />

    <template v-else>
      <p v-if="saveError" class="form-alert" role="alert">{{ saveError }}</p>
      <p v-else-if="saved" class="save-ok" role="status">已保存</p>

      <UCard class="settings-card">
        <h2 class="section-title">登录（OIDC）</h2>
        <div class="settings-grid">
          <UInput v-model="issuer" label="Issuer" type="url" placeholder="https://idp.example.com" />
          <UInput v-model="clientId" label="Client ID" />
          <UInput
            v-model="clientSecret"
            label="Client Secret"
            type="password"
            :placeholder="oidcSecretConfigured ? SECRET_MASK : '未配置'"
          />
          <p class="secret-hint">{{ oidcSecretConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
          <UInput v-model="scope" label="Scope" placeholder="openid profile email" />
        </div>

        <UButton variant="outline" :loading="testing" class="test-btn" @click="onTestConnection">
          测试连接
        </UButton>

        <p v-if="testFailReason" class="form-alert" role="alert">{{ testFailReason }}</p>
        <div v-if="testOk" class="test-result" role="status">
          <p class="test-ok-line">连接成功</p>
          <p v-for="warning in testOk.warnings" :key="warning" class="test-warning">
            {{ warning }}
          </p>
        </div>
      </UCard>

      <UCard class="settings-card">
        <div class="mail-card-head">
          <h2 class="section-title">邮件（可选，未配置即弱化实例）</h2>
          <!-- 无 mail 行时开关禁用（避免「开但无配置」状态）；aria-label 独立于可见标题 -->
          <USwitch
            :model-value="mailAxisOn"
            :disabled="!mailConfigured"
            aria-label="邮件服务开关"
            @update:model-value="onToggleMailEnabled"
          />
        </div>
        <p v-if="!mailConfigured" class="mail-switch-hint">填写并保存配置后即可开启</p>
        <p v-else-if="!mailEnabled" class="mail-switch-hint">
          关闭后新成员不再开户与发信；已开通的邮箱不受影响
        </p>

        <!-- 轴开：与既有结构逐字一致（表单平铺、测试可用、无提示行） -->
        <template v-if="mailAxisOn">
          <div class="settings-grid">
            <UInput v-model="baseUrl" label="Stalwart 地址" type="url" placeholder="https://mail.example.com" />
            <UInput
              v-model="apiKey"
              label="API Key"
              type="password"
              :placeholder="apiKeyConfigured ? SECRET_MASK : '未配置'"
            />
            <p class="secret-hint">{{ apiKeyConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
            <UInput v-model="domain" label="邮箱域名" placeholder="example.com" />
            <UInput v-model="host" label="SMTP 主机" placeholder="mail.example.com" />
            <UInput
              v-model="port"
              label="SMTP 端口（纯数字，如 465）"
              type="text"
              inputmode="numeric"
              placeholder="465"
            />
            <UInput v-model="username" label="SMTP 用户名" />
            <UInput
              v-model="password"
              label="SMTP 密码"
              type="password"
              :placeholder="passwordConfigured ? SECRET_MASK : '未配置'"
            />
            <p class="secret-hint">{{ passwordConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
            <UInput v-model="from" label="发件地址" placeholder="no-reply@example.com" />
          </div>

          <UButton variant="outline" :loading="mailTesting" class="test-btn" @click="onTestMailConnection">
            测试连接
          </UButton>
          <p v-if="mailTestError" class="form-alert" role="alert">{{ mailTestError }}</p>
          <div v-if="mailTest" class="mail-test-results" role="status">
            <!-- 以轴名（provisioner/sender）做 key，detail 文本可能重复不能当 key（#139） -->
            <div
              v-for="(item, axis) in mailTest"
              :key="axis"
              :class="['mail-test-card', item.ok ? 'is-ok' : 'is-fail']"
            >
              <strong>{{ item.ok ? '成功' : '失败' }}</strong>
              <span>{{ item.detail }}</span>
            </div>
          </div>
        </template>

        <!-- 轴关（含无配置）：配置区收进折叠项（SetupView details 口径），测试按钮禁用 -->
        <details v-else class="mail-config-toggle">
          <summary class="mail-config-summary">展开邮件服务配置</summary>
          <div class="settings-grid">
            <UInput v-model="baseUrl" label="Stalwart 地址" type="url" placeholder="https://mail.example.com" />
            <UInput
              v-model="apiKey"
              label="API Key"
              type="password"
              :placeholder="apiKeyConfigured ? SECRET_MASK : '未配置'"
            />
            <p class="secret-hint">{{ apiKeyConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
            <UInput v-model="domain" label="邮箱域名" placeholder="example.com" />
            <UInput v-model="host" label="SMTP 主机" placeholder="mail.example.com" />
            <UInput
              v-model="port"
              label="SMTP 端口（纯数字，如 465）"
              type="text"
              inputmode="numeric"
              placeholder="465"
            />
            <UInput v-model="username" label="SMTP 用户名" />
            <UInput
              v-model="password"
              label="SMTP 密码"
              type="password"
              :placeholder="passwordConfigured ? SECRET_MASK : '未配置'"
            />
            <p class="secret-hint">{{ passwordConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
            <UInput v-model="from" label="发件地址" placeholder="no-reply@example.com" />
          </div>

          <UButton variant="outline" :loading="mailTesting" :disabled="!mailAxisOn" class="test-btn" @click="onTestMailConnection">
            测试连接
          </UButton>
          <p v-if="mailTestError" class="form-alert" role="alert">{{ mailTestError }}</p>
          <div v-if="mailTest" class="mail-test-results" role="status">
            <div
              v-for="(item, axis) in mailTest"
              :key="axis"
              :class="['mail-test-card', item.ok ? 'is-ok' : 'is-fail']"
            >
              <strong>{{ item.ok ? '成功' : '失败' }}</strong>
              <span>{{ item.detail }}</span>
            </div>
          </div>
        </details>
      </UCard>

      <UButton :loading="saving" @click="onSave">保存</UButton>
    </template>
  </div>
</template>

<style scoped>
@import './page.css';

.settings-card {
  margin-bottom: var(--unself-space-4);
}
/* 邮件卡头部：标题 + 开关一行（开关 aria-label 独立于可见标题） */
.mail-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
}
.mail-switch-hint {
  margin: 0 0 var(--unself-space-3);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
}
/* 折叠口径照抄 SetupView .setup-oidc-toggle/.setup-oidc-summary（全部 tokens） */
.mail-config-toggle {
  margin-top: var(--unself-space-5);
  border-top: 1px solid var(--unself-color-border);
  padding-top: var(--unself-space-4);
}
.mail-config-summary {
  cursor: pointer;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
  user-select: none;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--unself-space-4);
  align-items: start;
}
.secret-hint {
  grid-column: 2;
  margin: calc(-1 * var(--unself-space-2)) 0 var(--unself-space-2);
  padding: 0 var(--unself-space-1);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}
.test-btn {
  margin-top: var(--unself-space-2);
}
.test-result {
  margin-top: var(--unself-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.test-ok-line {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-success);
  font-weight: 500;
}
/* 黄牌：warning 色描边 + 文字（无 warning-soft 令牌，不造裸值） */
.test-warning {
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border: 1px solid var(--unself-color-warning);
  border-radius: var(--unself-radius-md);
  color: var(--unself-color-warning);
  font-size: var(--unself-font-size-sm);
}
.mail-test-results { margin-top: var(--unself-space-3); display: grid; gap: var(--unself-space-2); }
.mail-test-card { padding: var(--unself-space-2) var(--unself-space-3); border: 1px solid currentColor; border-radius: var(--unself-radius-md); display: flex; gap: var(--unself-space-2); }
.mail-test-card.is-ok { color: var(--unself-color-success); }
.mail-test-card.is-fail { color: var(--unself-color-danger); }
.save-ok {
  margin: 0 0 var(--unself-space-3);
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-success);
}

@media (max-width: 768px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .secret-hint {
    grid-column: 1;
  }
}
</style>
