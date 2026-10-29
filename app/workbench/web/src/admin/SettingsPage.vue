<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 管理台设置页（#17 → #340 三段 → #100 三行清单 + 水舱弹窗）。形制全在决策 #100，此处只记实现要点：
 * - 三行：OIDC 无开关、「编辑配置」恒显；邮件两行（Stalwart / SMTP）是持久能力开关，
 *   「编辑配置」只在启用态渲染（停用行没有编辑入口：要改字段必须先开）。
 * - 开关直落库：配置完整 → 只 PUT {enabled}；配置不全点「开」→ 不落库、开弹窗（enablePending，
 *   保存恒带 enabled:true）；点「关」恒 PUT {enabled:false}。在途本行开关禁用，失败出行级 alert
 *   且开关仍是原状态（开关值只在 refetch 成功后才随服务端状态变）。
 * - 客户端完整性（stalwartComplete / smtpComplete）只决定直落库还是弹窗，不是校验边界，D5 400 才是。
 * - 弹窗动线：同一颗按钮非成功态「测试连接」、成功态变「保存配置」；「跳过测试，直接保存」仅非成功态出现。
 *   保存恒带 enabled:true；每次打开 / 关闭 / 保存成功都 resetDialogState，重开回到 rest 与初始态。
 * - 测试吃当前草稿（候选化，#97/#99）：密钥留空或 `***` 原样传，后端自己回退已存值；
 *   探测时抓草稿快照，返回时草稿已变则结果作废不回填，改字段也清掉已得结果。
 * - 写侧：OIDC 只发有变化的非空字段（不能清空）；邮件文本先 trim 整段回写、空串照发（后端删键，决策 #100），
 *   密钥只有新明文才带上。
 * - Stalwart 保存 / 开关直落库成功后重取 me（#340：壳层「应用密码」入口随 mailEnabled 显隐）。
 */
import { computed, ref, watch } from 'vue'

import { UButton, UErrorCard, UInput, USkeleton, USwitch } from '@unself/ui'

import {
  fetchSettings,
  saveOidcSettings,
  saveSmtpSettings,
  saveStalwartSettings,
  testSmtpConnection,
  testStalwartConnection,
  SECRET_MASK,
  type ApiError,
  type InstanceSettings,
  type MailTestResult,
  type OidcSettingsUpdate,
  type SmtpSettingsUpdate,
  type StalwartSettingsUpdate,
} from '../lib/admin-api'
import { testOidcConnection } from '../lib/setup-api'
import { fetchMe } from '../lib/session-api'
import { useAsyncLoad } from '../lib/use-async-load'
import SettingsConfigDialog from './settings-config-dialog.vue'

const { phase, loadError, data: settings } = useAsyncLoad<InstanceSettings>(fetchSettings)

const openDialog = ref<null | 'oidc' | 'stalwart' | 'smtp'>(null)
/** 配置不全点「开」：保存成功时带 enabled:true。 */
const enablePending = ref(false)

const issuer = ref('')
const clientId = ref('')
const clientSecret = ref('')
const scope = ref('')
const oidcSecretConfigured = ref(false)
const oidcTesting = ref(false)
/** 非 null = 测试成功，主动作按钮变为「保存配置」。改字段即清空。 */
const oidcTestOk = ref<string | null>(null)
const oidcTestFailReason = ref<string | null>(null)
const oidcSaving = ref(false)
const oidcSaveError = ref<string | null>(null)

const stalwartEnabled = ref(false)
const stalwartBaseUrl = ref('')
const stalwartApiKey = ref('')
const stalwartDomain = ref('')
/** 门户地址（#184）。 */
const stalwartPortalUrl = ref('')
const stalwartApiKeyConfigured = ref(false)
const stalwartSwitching = ref(false)
const stalwartRowError = ref<string | null>(null)
const stalwartTesting = ref(false)
const stalwartTestOk = ref<string | null>(null)
const stalwartTestError = ref<string | null>(null)
const stalwartSaving = ref(false)
const stalwartSaveError = ref<string | null>(null)

const smtpEnabled = ref(false)
const smtpHost = ref('')
const smtpPort = ref('')
const smtpUsername = ref('')
const smtpPassword = ref('')
const smtpFrom = ref('')
const smtpPasswordConfigured = ref(false)
const smtpSwitching = ref(false)
const smtpRowError = ref<string | null>(null)
const smtpTesting = ref(false)
const smtpTestOk = ref<string | null>(null)
const smtpTestError = ref<string | null>(null)
const smtpSaving = ref(false)
const smtpSaveError = ref<string | null>(null)

/** 数据就位 → 回填表单；每次保存 / 开关直落库后 refetch 再回填一次（不靠乐观更新）。 */
watch(settings, (s) => { if (s) applyLoaded(s) }, { immediate: true })

function applyLoaded(s: InstanceSettings): void {
  issuer.value = s.oidc.issuer
  clientId.value = s.oidc.clientId
  scope.value = s.oidc.scope
  oidcSecretConfigured.value = s.oidc.clientSecret === SECRET_MASK

  stalwartEnabled.value = s.stalwart.enabled
  stalwartBaseUrl.value = s.stalwart.baseUrl
  stalwartDomain.value = s.stalwart.domain
  stalwartPortalUrl.value = s.stalwart.portalUrl
  stalwartApiKeyConfigured.value = s.stalwart.apiKey === SECRET_MASK

  smtpEnabled.value = s.smtp.enabled
  smtpHost.value = s.smtp.host
  smtpPort.value = s.smtp.port === '' ? '' : String(s.smtp.port)
  smtpUsername.value = s.smtp.username
  smtpFrom.value = s.smtp.from
  smtpPasswordConfigured.value = s.smtp.password === SECRET_MASK
}

/** 失败人话：后端 detail 优先（D5 校验清单是人话），退化到 ApiError.message。 */
function actionErrorText(err: unknown): string {
  const apiErr = err as ApiError
  return apiErr?.detail ?? apiErr?.message
}

// 与 settings.ts 必填清单对齐。只决定直落库还是弹窗，不是校验边界。
const stalwartComplete = computed(
  () => stalwartBaseUrl.value.trim() !== ''
    && stalwartApiKeyConfigured.value
    && stalwartDomain.value.trim() !== '',
)
const smtpComplete = computed(
  () => smtpHost.value.trim() !== ''
    && /^[1-9]\d*$/.test(smtpPort.value)
    && smtpUsername.value.trim() !== ''
    && smtpPasswordConfigured.value
    && smtpFrom.value.trim() !== '',
)

async function onToggleStalwart(next: boolean): Promise<void> {
  if (!next) {
    await persistStalwartEnabled(false)
    return
  }
  if (stalwartComplete.value) {
    await persistStalwartEnabled(true)
    return
  }
  enablePending.value = true
  openDialog.value = 'stalwart'
}

async function onToggleSmtp(next: boolean): Promise<void> {
  if (!next) {
    await persistSmtpEnabled(false)
    return
  }
  if (smtpComplete.value) {
    await persistSmtpEnabled(true)
    return
  }
  enablePending.value = true
  openDialog.value = 'smtp'
}

/** 开关直落库（邮件两行）：只发 {enabled}，成功后 refetch 取服务端真值；失败留行级 alert，开关不动。 */
async function persistStalwartEnabled(enabled: boolean): Promise<void> {
  stalwartSwitching.value = true
  stalwartRowError.value = null
  try {
    await saveStalwartSettings({ enabled })
    const s = await fetchSettings()
    applyLoaded(s)
    void refreshMe()
  } catch (err) {
    stalwartRowError.value = actionErrorText(err)
  } finally {
    stalwartSwitching.value = false
  }
}

async function persistSmtpEnabled(enabled: boolean): Promise<void> {
  smtpSwitching.value = true
  smtpRowError.value = null
  try {
    await saveSmtpSettings({ enabled })
    const s = await fetchSettings()
    applyLoaded(s)
  } catch (err) {
    smtpRowError.value = actionErrorText(err)
  } finally {
    smtpSwitching.value = false
  }
}

/** 只发非空字段。密钥只带新明文，空串和 `***` 都不发。 */
function buildOidcUpdate(): OidcSettingsUpdate {
  const oidc: OidcSettingsUpdate = {}
  if (issuer.value) oidc.issuer = issuer.value
  if (clientId.value) oidc.clientId = clientId.value
  if (scope.value) oidc.scope = scope.value
  if (clientSecret.value && clientSecret.value !== SECRET_MASK) oidc.clientSecret = clientSecret.value
  return oidc
}

async function onTestOidc(): Promise<void> {
  // 探测只吃 issuer（与 setup 流程同端点）；其余草稿字段仅用于「在途改过即作废」对照
  const tested = { issuer: issuer.value, clientId: clientId.value, scope: scope.value, secret: clientSecret.value }
  oidcTesting.value = true
  oidcTestOk.value = null
  oidcTestFailReason.value = null
  try {
    const result = await testOidcConnection(issuer.value)
    if (tested.issuer !== issuer.value || tested.clientId !== clientId.value
      || tested.scope !== scope.value || tested.secret !== clientSecret.value) return
    if (result.ok) {
      oidcTestOk.value = result.warnings.length > 0
        ? `连接成功（${result.warnings.join('；')}）`
        : '连接成功'
    } else {
      oidcTestFailReason.value = result.reason
    }
  } catch (err) {
    oidcTestFailReason.value = actionErrorText(err)
  } finally {
    oidcTesting.value = false
  }
}

/** OIDC 保存：后端详情 = 后端校验人话；成功后关弹窗、重取设置（不回显密钥）。 */
async function onSaveOidc(): Promise<void> {
  oidcSaving.value = true
  oidcSaveError.value = null
  try {
    const update = buildOidcUpdate()
    await saveOidcSettings(update)
    if (update.clientSecret) {
      oidcSecretConfigured.value = true
      clientSecret.value = ''
    }
    openDialog.value = null
    resetDialogState()
    const s = await fetchSettings()
    applyLoaded(s)
  } catch (err) {
    oidcSaveError.value = actionErrorText(err)
  } finally {
    oidcSaving.value = false
  }
}

watch([issuer, clientId, clientSecret, scope], () => {
  oidcTestOk.value = null
  oidcTestFailReason.value = null
})

/** 文本 trim 后整段回写，空串照发（后端删键，#100）。密钥只带新明文。 */
function buildStalwartUpdate(enabled: boolean): StalwartSettingsUpdate {
  const stalwart: StalwartSettingsUpdate = {}
  stalwart.baseUrl = stalwartBaseUrl.value.trim()
  stalwart.domain = stalwartDomain.value.trim()
  stalwart.portalUrl = stalwartPortalUrl.value.trim()
  if (stalwartApiKey.value && stalwartApiKey.value !== SECRET_MASK) stalwart.apiKey = stalwartApiKey.value
  stalwart.enabled = enabled
  return stalwart
}

async function onTestStalwart(): Promise<void> {
  const tested = {
    baseUrl: stalwartBaseUrl.value,
    apiKey: stalwartApiKey.value,
    domain: stalwartDomain.value,
    portalUrl: stalwartPortalUrl.value,
  }
  stalwartTesting.value = true
  stalwartTestOk.value = null
  stalwartTestError.value = null
  try {
    const result: MailTestResult = await testStalwartConnection({
      baseUrl: tested.baseUrl,
      apiKey: tested.apiKey,
      domain: tested.domain,
    })
    if (!sameStalwartDraft(tested)) return
    if (result.ok) {
      stalwartTestOk.value = result.detail
    } else {
      stalwartTestError.value = result.detail
    }
  } catch (err) {
    if (!sameStalwartDraft(tested)) return
    stalwartTestError.value = actionErrorText(err)
  } finally {
    stalwartTesting.value = false
  }
}

function sameStalwartDraft(tested: {
  baseUrl: string
  apiKey: string
  domain: string
  portalUrl: string
}): boolean {
  return tested.baseUrl === stalwartBaseUrl.value
    && tested.apiKey === stalwartApiKey.value
    && tested.domain === stalwartDomain.value
    && tested.portalUrl === stalwartPortalUrl.value
}

async function onSaveStalwart(): Promise<void> {
  stalwartSaving.value = true
  stalwartSaveError.value = null
  try {
    const update = buildStalwartUpdate(true)
    await saveStalwartSettings(update)
    if (update.apiKey) {
      stalwartApiKeyConfigured.value = true
      stalwartApiKey.value = ''
    }
    openDialog.value = null
    enablePending.value = false
    resetDialogState()
    const s = await fetchSettings()
    applyLoaded(s)
    void refreshMe()
  } catch (err) {
    stalwartSaveError.value = actionErrorText(err)
  } finally {
    stalwartSaving.value = false
  }
}

watch([stalwartBaseUrl, stalwartApiKey, stalwartDomain, stalwartPortalUrl], () => {
  stalwartTestOk.value = null
  stalwartTestError.value = null
})

/** 文本整段回写。port 空串照发，有值发正整数；密码只带新明文。 */
function buildSmtpUpdate(enabled: boolean): SmtpSettingsUpdate {
  const smtp: SmtpSettingsUpdate = {}
  smtp.host = smtpHost.value.trim()
  smtp.port = smtpPort.value.trim() === '' ? '' : Number(smtpPort.value)
  smtp.username = smtpUsername.value.trim()
  smtp.from = smtpFrom.value.trim()
  if (smtpPassword.value && smtpPassword.value !== SECRET_MASK) smtp.password = smtpPassword.value
  smtp.enabled = enabled
  return smtp
}

async function onTestSmtp(): Promise<void> {
  const tested = {
    host: smtpHost.value,
    port: smtpPort.value,
    username: smtpUsername.value,
    password: smtpPassword.value,
    from: smtpFrom.value,
  }
  smtpTesting.value = true
  smtpTestOk.value = null
  smtpTestError.value = null
  try {
    const result: MailTestResult = await testSmtpConnection({
      host: tested.host,
      port: tested.port,
      username: tested.username,
      password: tested.password,
      from: tested.from,
    })
    if (!sameSmtpDraft(tested)) return
    if (result.ok) {
      smtpTestOk.value = result.detail
    } else {
      smtpTestError.value = result.detail
    }
  } catch (err) {
    if (!sameSmtpDraft(tested)) return
    smtpTestError.value = actionErrorText(err)
  } finally {
    smtpTesting.value = false
  }
}

function sameSmtpDraft(tested: {
  host: string
  port: string
  username: string
  password: string
  from: string
}): boolean {
  return tested.host === smtpHost.value
    && tested.port === smtpPort.value
    && tested.username === smtpUsername.value
    && tested.password === smtpPassword.value
    && tested.from === smtpFrom.value
}

async function onSaveSmtp(): Promise<void> {
  smtpSaving.value = true
  smtpSaveError.value = null
  try {
    const update = buildSmtpUpdate(true)
    await saveSmtpSettings(update)
    if (update.password) {
      smtpPasswordConfigured.value = true
      smtpPassword.value = ''
    }
    openDialog.value = null
    enablePending.value = false
    resetDialogState()
    const s = await fetchSettings()
    applyLoaded(s)
  } catch (err) {
    smtpSaveError.value = actionErrorText(err)
  } finally {
    smtpSaving.value = false
  }
}

watch([smtpHost, smtpPort, smtpUsername, smtpPassword, smtpFrom], () => {
  smtpTestOk.value = null
  smtpTestError.value = null
})

const stalwartRowDesc = computed(() => {
  if (stalwartEnabled.value) return '已启用 · 新成员将自动开户'
  return stalwartComplete.value ? '已停用 · 配置已保留' : '未配置'
})
const smtpRowDesc = computed(() => {
  if (smtpEnabled.value) return '已启用 · 实例将发送通知邮件'
  return smtpComplete.value ? '已停用 · 配置已保留' : '未配置'
})
const oidcRowDesc = computed(() =>
  issuer.value.trim() !== '' && clientId.value.trim() !== '' && oidcSecretConfigured.value
    ? '已配置'
    : '未配置',
)

const dialogTitle = computed(() => {
  switch (openDialog.value) {
    case 'oidc': return '编辑登录（OIDC）'
    case 'stalwart': return enablePending.value ? '启用邮箱管理（Stalwart）' : '编辑邮箱管理（Stalwart）'
    case 'smtp': return enablePending.value ? '启用通知发信（SMTP）' : '编辑通知发信（SMTP）'
    default: return ''
  }
})
const dialogHint = computed(() =>
  enablePending.value ? '配置保存后将自动启用该功能' : '',
)

function resetDialogState(): void {
  oidcTestOk.value = null
  oidcTestFailReason.value = null
  oidcSaveError.value = null
  stalwartTestOk.value = null
  stalwartTestError.value = null
  stalwartSaveError.value = null
  smtpTestOk.value = null
  smtpTestError.value = null
  smtpSaveError.value = null
}

function closeDialog(): void {
  openDialog.value = null
  enablePending.value = false
  resetDialogState()
}

function openEdit(domain: 'oidc' | 'stalwart' | 'smtp'): void {
  resetDialogState()
  enablePending.value = false
  openDialog.value = domain
}

function boxOpen(domain: 'oidc' | 'stalwart' | 'smtp') {
  return computed({
    get: () => openDialog.value === domain,
    set: (v: boolean) => {
      if (v) {
        resetDialogState()
        openDialog.value = domain
        return
      }
      if (openDialog.value === domain) closeDialog()
    },
  })
}
const oidcOpen = boxOpen('oidc')
const stalwartOpen = boxOpen('stalwart')
const smtpOpen = boxOpen('smtp')

/** 壳层「应用密码」入口随 mailEnabled 显隐（#340）。 */
async function refreshMe(): Promise<void> {
  try {
    await fetchMe()
  } catch {
    // 失败不影响保存结果，下次进页重取
  }
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
      <div class="settings-list" data-test="settings-list">
        <div class="settings-row" data-test="settings-row-oidc">
          <div class="settings-row-main">
            <span class="settings-row-title">登录（OIDC）</span>
            <span class="settings-row-desc">{{ oidcRowDesc }}</span>
          </div>
          <UButton
            variant="outline"
            size="sm"
            data-test="settings-edit-oidc"
            @click="openEdit('oidc')"
          >
            编辑配置
          </UButton>
        </div>

        <div class="settings-row" data-test="settings-row-stalwart">
          <div class="settings-row-main">
            <span class="settings-row-title">邮箱管理（Stalwart）</span>
            <span class="settings-row-desc">{{ stalwartRowDesc }}</span>
          </div>
          <div class="settings-row-actions">
            <UButton
              v-if="stalwartEnabled"
              variant="outline"
              size="sm"
              data-test="settings-edit-stalwart"
              @click="openEdit('stalwart')"
            >
              编辑配置
            </UButton>

            <USwitch
              :model-value="stalwartEnabled"
              :disabled="stalwartSwitching"
              aria-label="邮箱管理开关"
              data-test="settings-switch-stalwart"
              @update:model-value="onToggleStalwart"
            />
          </div>
        </div>

        <div class="settings-row" data-test="settings-row-smtp">
          <div class="settings-row-main">
            <span class="settings-row-title">通知发信（SMTP）</span>
            <span class="settings-row-desc">{{ smtpRowDesc }}</span>
          </div>
          <div class="settings-row-actions">
            <UButton
              v-if="smtpEnabled"
              variant="outline"
              size="sm"
              data-test="settings-edit-smtp"
              @click="openEdit('smtp')"
            >
              编辑配置
            </UButton>
            <USwitch
              :model-value="smtpEnabled"
              :disabled="smtpSwitching"
              aria-label="通知发信开关"
              data-test="settings-switch-smtp"
              @update:model-value="onToggleSmtp"
            />
          </div>
        </div>
      </div>

      <p v-if="stalwartRowError" class="form-alert settings-row-alert" role="alert" data-test="settings-row-alert-stalwart">
        {{ stalwartRowError }}
      </p>
      <p v-if="smtpRowError" class="form-alert settings-row-alert" role="alert" data-test="settings-row-alert-smtp">
        {{ smtpRowError }}
      </p>

      <SettingsConfigDialog
        v-model="oidcOpen"
        domain="oidc"
        :title="openDialog === 'oidc' ? dialogTitle : ''"
        :testing="oidcTesting"
        :saving="oidcSaving"
        :ok-detail="oidcTestOk"
        :error-text="oidcTestFailReason ?? oidcSaveError"
        @test="onTestOidc"
        @save="onSaveOidc"
      >
        <UInput v-model="issuer" label="Issuer" name="oidc-issuer" type="url" placeholder="https://idp.example.com" />
        <UInput v-model="clientId" label="Client ID" name="oidc-client-id" />
        <UInput
          v-model="clientSecret"
          label="Client Secret"
          name="oidc-client-secret"
          type="password"
          :placeholder="oidcSecretConfigured ? SECRET_MASK : '未配置'"
        />
        <p class="secret-hint">{{ oidcSecretConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
        <UInput v-model="scope" label="Scope" name="oidc-scope" placeholder="openid profile email" />
      </SettingsConfigDialog>

      <SettingsConfigDialog
        v-model="stalwartOpen"
        domain="stalwart"
        :title="openDialog === 'stalwart' ? dialogTitle : ''"
        :hint="openDialog === 'stalwart' ? dialogHint : ''"
        :testing="stalwartTesting"
        :saving="stalwartSaving"
        :ok-detail="stalwartTestOk"
        :error-text="stalwartTestError ?? stalwartSaveError"
        @test="onTestStalwart"
        @save="onSaveStalwart"
      >
        <UInput v-model="stalwartBaseUrl" label="Stalwart 地址" name="stalwart-baseurl" type="url" placeholder="https://mail.example.com" />
        <UInput
          v-model="stalwartApiKey"
          label="API Key"
          name="stalwart-apikey"
          type="password"
          :placeholder="stalwartApiKeyConfigured ? SECRET_MASK : '未配置'"
        />
        <p class="secret-hint">{{ stalwartApiKeyConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
        <UInput v-model="stalwartDomain" label="邮箱域名" name="stalwart-domain" placeholder="example.com" />
        <UInput
          v-model="stalwartPortalUrl"
          label="邮箱门户地址（可选）"
          name="stalwart-portal"
          type="url"
          placeholder="留空 = 按邮箱域名自动推导"
        />
        <p class="secret-hint">
          成员「应用密码说明页」的跳转目标；留空则按邮箱域名推导（https://mail.&lt;域名&gt;）。
        </p>
      </SettingsConfigDialog>

      <SettingsConfigDialog
        v-model="smtpOpen"
        domain="smtp"
        :title="openDialog === 'smtp' ? dialogTitle : ''"
        :hint="openDialog === 'smtp' ? dialogHint : ''"
        :testing="smtpTesting"
        :saving="smtpSaving"
        :ok-detail="smtpTestOk"
        :error-text="smtpTestError ?? smtpSaveError"
        @test="onTestSmtp"
        @save="onSaveSmtp"
      >
        <UInput v-model="smtpHost" label="SMTP 主机" name="smtp-host" placeholder="mail.example.com" />
        <UInput
          v-model="smtpPort"
          label="SMTP 端口（纯数字，如 465）"
          name="smtp-port"
          type="text"
          inputmode="numeric"
          placeholder="465"
        />
        <UInput v-model="smtpUsername" label="SMTP 用户名" name="smtp-username" />
        <UInput
          v-model="smtpPassword"
          label="SMTP 密码"
          name="smtp-password"
          type="password"
          :placeholder="smtpPasswordConfigured ? SECRET_MASK : '未配置'"
        />
        <p class="secret-hint">{{ smtpPasswordConfigured ? '已配置，留空表示不修改' : '尚未配置' }}</p>
        <UInput v-model="smtpFrom" label="发件地址" name="smtp-from" placeholder="no-reply@example.com" />
      </SettingsConfigDialog>
    </template>
  </div>
</template>

<style scoped>
@import './page.css';

.settings-list {
  display: flex;
  flex-direction: column;
  margin-bottom: var(--unself-space-4);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-surface);
  box-shadow: var(--unself-shadow-card);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
  padding: var(--unself-space-4);
}
.settings-row + .settings-row {
  border-top: 1px solid var(--unself-color-border);
}
.settings-row-main {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  min-width: 0;
}
.settings-row-title {
  font-size: var(--unself-font-size-base);
  font-weight: 500;
  color: var(--unself-color-text);
}
.settings-row-desc {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-tertiary);
}
.settings-row-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--unself-space-3);
}
.settings-row-alert {
  margin-top: var(--unself-space-3);
}
.secret-hint {
  grid-column: 2;
  margin: calc(-1 * var(--unself-space-2)) 0 var(--unself-space-2);
  padding: 0 var(--unself-space-1);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}

@media (max-width: 768px) {
  .settings-row {
    flex-wrap: wrap;
  }
  .secret-hint {
    grid-column: 1;
  }
}
</style>
