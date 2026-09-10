<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { UButton, UCard, UErrorCard, UInput, USkeleton } from '@unself/ui'

import {
  fetchSettings,
  saveSettings,
  SECRET_MASK,
  type ApiError,
  type InstanceSettings,
} from '../lib/admin-api'
import { testOidcConnection } from '../lib/setup-api'

/**
 * 管理台设置页（#17）：OIDC 段 + mail 段查看/编辑 + 测试连接（含 warnings 黄牌）。
 * 密钥字段只写不读：服务端 GET 恒回 '***'，前端留空即不修改（不做客户端二次校验）。
 * 不做：DYN DNS、存储段、多套配置 profile。
 */

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref<ApiError | null>(null)

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

onMounted(load)

async function load(): Promise<void> {
  phase.value = 'loading'
  try {
    const s = await fetchSettings()
    applyLoaded(s)
    phase.value = 'ready'
  } catch (err) {
    loadError.value = err as ApiError
    phase.value = 'error'
  }
}

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
  if (port.value) mail.port = port.value
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
        <h2 class="section-title">邮件（可选，未配置即弱化实例）</h2>
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
          <UInput v-model="port" label="SMTP 端口" placeholder="465" />
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
