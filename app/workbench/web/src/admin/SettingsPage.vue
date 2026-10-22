<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, watch } from 'vue'

import { UButton, UCard, UErrorCard, UInput, USkeleton, USwitch } from '@unself/ui'

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

/**
 * 管理台设置页（#17 → #340 三卡分域）：登录（OIDC）/ 邮箱管理（Stalwart）/ 通知发信（SMTP）
 * 三张独立 UCard，各卡独立启停、测试、保存，状态互不干扰（#139 语义延续到卡粒度）。
 * - 动线（#99）：「开（关）→ 填 → 测试 → 保存」任意顺序——
 *   ① 开关是纯表单字段（#159 落到底）：恒可切、只改本地状态，点本卡「保存」才落库；
 *     开启但字段不全由后端 D5 400 人话兜底（fail-closed 不变）；
 *   ② 配置区常显：无折叠（不采用 #159 的 `mailAxisOn || !mailConfigured` 收起式，保存不影响布局）；
 *   ③ 测试连接恒可用：吃当前表单草稿（#340 候选化），缺字段由后端回 200 ok:false 人话；
 *     密钥留空或 *** 原样传给后端（后端自己回退已存值）；本卡任一字段变更 → 丢弃本卡测试结果
 *     （含在途：探测时抓草稿快照，返回时草稿已变则结果作废）。
 * - 保存 body 恒带 enabled（#99）；段不存在且只要求关闭时后端按默认态幂等空操作，不建段。
 * - 密钥字段只写不读：服务端 GET 恒回 '***'，前端留空即不修改（不做客户端二次校验）。
 * - OIDC 卡保存只发 { oidc }（#340：不再夹带任何邮件字段）；Stalwart 卡保存成功后
 *   me 重取一次，壳层「应用密码」入口随新 mailEnabled 自动显隐。
 */

// #142：加载三态样板收编 use-async-load（phase/loadError 变量名不变）
const { phase, loadError, data: settings } = useAsyncLoad<InstanceSettings>(fetchSettings)

// ---- 登录（OIDC）卡 ------------------------------------------------------

const issuer = ref('')
const clientId = ref('')
const clientSecret = ref('')
const scope = ref('')
/** 已配置密钥的提示（GET 返回 '***' 即已配置）。 */
const oidcSecretConfigured = ref(false)

const oidcSaving = ref(false)
const oidcSaveError = ref<string | null>(null)
const oidcSaved = ref(false)
const oidcTesting = ref(false)
const oidcTestOk = ref<null | { warnings: string[] }>(null)
const oidcTestFailReason = ref<string | null>(null)

// ---- 邮箱管理（Stalwart）卡 ---------------------------------------------

const stalwartEnabled = ref(true)
const stalwartBaseUrl = ref('')
const stalwartApiKey = ref('')
const stalwartDomain = ref('')
/** 门户地址（#184）：应用密码说明页的跳转目标；留空则由后端按邮箱域名推导。 */
const stalwartPortalUrl = ref('')
/** 服务端当前存的 portalUrl：用于判断「用户是否真的改了」——没动过的空值不下发，避免无配置实例凭空建段。 */
const loadedStalwartPortalUrl = ref('')
const stalwartApiKeyConfigured = ref(false)

const stalwartSaving = ref(false)
const stalwartSaveError = ref<string | null>(null)
const stalwartSaved = ref(false)
const stalwartTesting = ref(false)
const stalwartTestError = ref<string | null>(null)
const stalwartTest = ref<MailTestResult | null>(null)

// ---- 通知发信（SMTP）卡 --------------------------------------------------

const smtpEnabled = ref(true)
const smtpHost = ref('')
const smtpPort = ref('')
const smtpUsername = ref('')
const smtpPassword = ref('')
const smtpFrom = ref('')
const smtpPasswordConfigured = ref(false)

const smtpSaving = ref(false)
const smtpSaveError = ref<string | null>(null)
const smtpSaved = ref(false)
const smtpTesting = ref(false)
const smtpTestError = ref<string | null>(null)
const smtpTest = ref<MailTestResult | null>(null)

// 数据就位 → 回填表单（含保存后无需重新拉取的既有行为）
watch(settings, (s) => { if (s) applyLoaded(s) }, { immediate: true })

function applyLoaded(s: InstanceSettings): void {
  issuer.value = s.oidc.issuer
  clientId.value = s.oidc.clientId
  scope.value = s.oidc.scope
  oidcSecretConfigured.value = s.oidc.clientSecret === SECRET_MASK

  stalwartBaseUrl.value = s.stalwart.baseUrl
  stalwartDomain.value = s.stalwart.domain
  stalwartPortalUrl.value = s.stalwart.portalUrl
  loadedStalwartPortalUrl.value = s.stalwart.portalUrl
  stalwartApiKeyConfigured.value = s.stalwart.apiKey === SECRET_MASK
  stalwartEnabled.value = s.stalwart.enabled

  smtpHost.value = s.smtp.host
  smtpPort.value = s.smtp.port === '' ? '' : String(s.smtp.port)
  smtpUsername.value = s.smtp.username
  smtpFrom.value = s.smtp.from
  smtpPasswordConfigured.value = s.smtp.password === SECRET_MASK
  smtpEnabled.value = s.smtp.enabled
}

/** 保存/测试失败人话：后端 detail 优先（D5 校验清单是人话），退化到 ApiError.message。 */
function actionErrorText(err: unknown): string {
  const apiErr = err as ApiError
  return apiErr?.detail ?? apiErr?.message
}

// ---- OIDC 卡：构建 + 保存 + 测试 ----------------------------------------

/** OIDC PUT body：只发有变化的字段；密钥只在填了新值（非空且非 ***）时发送；不带任何邮件字段。 */
function buildOidcUpdate(): OidcSettingsUpdate {
  const oidc: OidcSettingsUpdate = {}
  if (issuer.value) oidc.issuer = issuer.value
  if (clientId.value) oidc.clientId = clientId.value
  if (scope.value) oidc.scope = scope.value
  if (clientSecret.value && clientSecret.value !== SECRET_MASK) oidc.clientSecret = clientSecret.value
  return oidc
}

async function onSaveOidc(): Promise<void> {
  oidcSaving.value = true
  oidcSaveError.value = null
  oidcSaved.value = false
  try {
    const update = buildOidcUpdate()
    await saveOidcSettings(update)
    oidcSaved.value = true
    // 密钥保存后清空输入（不回显真值），「已配置」提示翻转
    if (update.clientSecret) {
      oidcSecretConfigured.value = true
      clientSecret.value = ''
    }
  } catch (err) {
    oidcSaveError.value = actionErrorText(err)
  } finally {
    oidcSaving.value = false
  }
}

async function onTestOidcConnection(): Promise<void> {
  oidcTesting.value = true
  oidcTestOk.value = null
  oidcTestFailReason.value = null
  const result = await testOidcConnection(issuer.value)
  if (result.ok) {
    oidcTestOk.value = { warnings: result.warnings }
  } else {
    oidcTestFailReason.value = result.reason
  }
  oidcTesting.value = false
}

// ---- Stalwart 卡：构建 + 保存 + 测试 + 开关 ------------------------------

/** Stalwart PUT body：只发有变化的字段（合并语义沿用）；#184 portalUrl 只在真的改过时下发。 */
function buildStalwartUpdate(): StalwartSettingsUpdate {
  const stalwart: StalwartSettingsUpdate = {}
  if (stalwartBaseUrl.value) stalwart.baseUrl = stalwartBaseUrl.value
  if (stalwartDomain.value) stalwart.domain = stalwartDomain.value
  const nextPortalUrl = stalwartPortalUrl.value.trim()
  if (nextPortalUrl !== loadedStalwartPortalUrl.value) stalwart.portalUrl = nextPortalUrl
  if (stalwartApiKey.value && stalwartApiKey.value !== SECRET_MASK) stalwart.apiKey = stalwartApiKey.value
  // #99：开关恒是表单字段——enabled 恒携带；段不存在 + 只要求关闭时由后端按默认态幂等空操作（不建段）
  stalwart.enabled = stalwartEnabled.value
  return stalwart
}

/** me 重取（#340）：壳层「应用密码」入口随新 mailEnabled 显隐；失败静默（下次进页自然重取）。 */
async function refreshMe(): Promise<void> {
  try {
    await fetchMe()
  } catch {
    // 会话态重取失败不影响保存结果
  }
}

async function onSaveStalwart(): Promise<void> {
  stalwartSaving.value = true
  stalwartSaveError.value = null
  stalwartSaved.value = false
  try {
    const update = buildStalwartUpdate()
    await saveStalwartSettings(update)
    stalwartSaved.value = true
    // 保存成功 = 服务端状态与表单一致 → 刷新基线（否则「填地址保存 → 清空再保存」第二次不下发清空）
    if (typeof update.portalUrl === 'string') loadedStalwartPortalUrl.value = update.portalUrl
    // 密钥保存后清空输入（不回显真值），「已配置」提示翻转
    if (update.apiKey) {
      stalwartApiKeyConfigured.value = true
      stalwartApiKey.value = ''
    }
    void refreshMe()
  } catch (err) {
    stalwartSaveError.value = actionErrorText(err)
  } finally {
    stalwartSaving.value = false
  }
}

async function onTestStalwart(): Promise<void> {
  // 竞态面（#99）：记下本次探测用的草稿快照；在途期间用户改过任意字段 → 结果作废不回填
  const tested = {
    baseUrl: stalwartBaseUrl.value,
    apiKey: stalwartApiKey.value,
    domain: stalwartDomain.value,
    portalUrl: stalwartPortalUrl.value,
  }
  stalwartTesting.value = true
  stalwartTestError.value = null
  stalwartTest.value = null
  try {
    // 候选化（#340）：发当前表单草稿；密钥留空/'***' 原样传（后端自己回退已存值）
    const result = await testStalwartConnection({
      baseUrl: tested.baseUrl,
      apiKey: tested.apiKey,
      domain: tested.domain,
    })
    if (!sameStalwartDraft(tested)) return
    stalwartTest.value = result
  } catch (err) {
    if (!sameStalwartDraft(tested)) return
    stalwartTestError.value = actionErrorText(err)
  } finally {
    stalwartTesting.value = false
  }
}

/** 草稿是否与探测时一致（#99 竞态面：任一字段改过即视为过期）。 */
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

/** #99：开关属表单状态——切换只改本地值，落库由本卡「保存」提交。 */
function onStalwartSwitch(next: boolean): void {
  stalwartEnabled.value = next
}

// ---- SMTP 卡：构建 + 保存 + 测试 + 开关 ----------------------------------

/** SMTP PUT body：只发有变化的字段（合并语义沿用；port 只在填了正整数时下发）。 */
function buildSmtpUpdate(): SmtpSettingsUpdate {
  const smtp: SmtpSettingsUpdate = {}
  if (smtpHost.value) smtp.host = smtpHost.value
  if (smtpPort.value) smtp.port = Number(smtpPort.value)
  if (smtpUsername.value) smtp.username = smtpUsername.value
  if (smtpFrom.value) smtp.from = smtpFrom.value
  if (smtpPassword.value && smtpPassword.value !== SECRET_MASK) smtp.password = smtpPassword.value
  // #99：开关恒是表单字段——enabled 恒携带；段不存在 + 只要求关闭时由后端按默认态幂等空操作（不建段）
  smtp.enabled = smtpEnabled.value
  return smtp
}

async function onSaveSmtp(): Promise<void> {
  smtpSaving.value = true
  smtpSaveError.value = null
  smtpSaved.value = false
  try {
    const update = buildSmtpUpdate()
    await saveSmtpSettings(update)
    smtpSaved.value = true
    if (update.password) {
      smtpPasswordConfigured.value = true
      smtpPassword.value = ''
    }
  } catch (err) {
    smtpSaveError.value = actionErrorText(err)
  } finally {
    smtpSaving.value = false
  }
}

async function onTestSmtp(): Promise<void> {
  // 竞态面（#99）：记下本次探测用的草稿快照；在途期间用户改过任意字段 → 结果作废不回填
  const tested = {
    host: smtpHost.value,
    port: smtpPort.value,
    username: smtpUsername.value,
    password: smtpPassword.value,
    from: smtpFrom.value,
  }
  smtpTesting.value = true
  smtpTestError.value = null
  smtpTest.value = null
  try {
    const result = await testSmtpConnection({
      host: tested.host,
      port: tested.port,
      username: tested.username,
      password: tested.password,
      from: tested.from,
    })
    if (!sameSmtpDraft(tested)) return
    smtpTest.value = result
  } catch (err) {
    if (!sameSmtpDraft(tested)) return
    smtpTestError.value = actionErrorText(err)
  } finally {
    smtpTesting.value = false
  }
}

/** 草稿是否与探测时一致（#99 竞态面：任一字段改过即视为过期）。 */
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

function onSmtpSwitch(next: boolean): void {
  smtpEnabled.value = next
}

// 本卡任一字段变更 → 丢弃本卡测试结果（纯客户端比对；#340）：结果区消失、错误提示一并清掉
watch([stalwartBaseUrl, stalwartApiKey, stalwartDomain, stalwartPortalUrl], () => {
  stalwartTest.value = null
  stalwartTestError.value = null
})
watch([smtpHost, smtpPort, smtpUsername, smtpPassword, smtpFrom], () => {
  smtpTest.value = null
  smtpTestError.value = null
})
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
      <!-- 卡一：登录（OIDC）；字段、测试按钮、结果区原样，仅保存改为只发 oidc（#340） -->
      <UCard class="settings-card" data-test="settings-card-oidc">
        <h2 class="section-title">登录（OIDC）</h2>
        <div class="settings-grid">
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
        </div>

        <UButton variant="outline" :loading="oidcTesting" class="test-btn" data-test="settings-test-oidc" @click="onTestOidcConnection">
          测试连接
        </UButton>

        <p v-if="oidcTestFailReason" class="form-alert" role="alert">{{ oidcTestFailReason }}</p>
        <div v-if="oidcTestOk" class="test-result" role="status">
          <p class="test-ok-line">连接成功</p>
          <p v-for="warning in oidcTestOk.warnings" :key="warning" class="test-warning">
            {{ warning }}
          </p>
        </div>

        <p v-if="oidcSaveError" class="form-alert" role="alert">{{ oidcSaveError }}</p>
        <p v-else-if="oidcSaved" class="save-ok" role="status">已保存</p>
        <UButton :loading="oidcSaving" class="card-save-btn" data-test="settings-save-oidc" @click="onSaveOidc">保存</UButton>
      </UCard>

      <!-- 卡二：邮箱管理（Stalwart 开户）；独立开关/测试/保存（#340）；动线 #99：表单常显、测试恒可用 -->
      <UCard class="settings-card" data-test="settings-card-stalwart">
        <div class="mail-card-head">
          <h2 class="section-title">邮箱管理（Stalwart）</h2>
          <!-- #99：开关纯表单字段恒可切；aria-label 独立于可见标题 -->
          <USwitch
            :model-value="stalwartEnabled"
            aria-label="邮箱管理开关"
            data-test="settings-switch-stalwart"
            @update:model-value="onStalwartSwitch"
          />
        </div>
        <p v-if="!stalwartEnabled" class="mail-switch-hint">
          关闭后新成员不再开户；已开通的邮箱不受影响
        </p>

        <!-- #99：配置区常显（无折叠——保存不再动布局；关态也可改配置、测试） -->
        <div class="stalwart-config" data-test="stalwart-config">
          <div class="settings-grid">
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
          </div>

          <!-- #99：测试恒可用（候选化探测不依赖开关状态）；缺字段由后端回人话结果 -->
          <UButton
            variant="outline"
            :loading="stalwartTesting"
            class="test-btn"
            data-test="settings-test-stalwart"
            @click="onTestStalwart"
          >
            测试连接
          </UButton>
          <p v-if="stalwartTestError" class="form-alert" role="alert">{{ stalwartTestError }}</p>
          <div v-if="stalwartTest" class="mail-test-results" role="status">
            <div class="mail-test-card" :class="stalwartTest.ok ? 'is-ok' : 'is-fail'">
              <strong>{{ stalwartTest.ok ? '成功' : '失败' }}</strong>
              <span>{{ stalwartTest.detail }}</span>
            </div>
          </div>
        </div>

        <!-- 卡内保存（#340）：各卡独立提交（开关+字段一次落库） -->
        <p v-if="stalwartSaveError" class="form-alert" role="alert">{{ stalwartSaveError }}</p>
        <p v-else-if="stalwartSaved" class="save-ok" role="status">已保存</p>
        <UButton :loading="stalwartSaving" class="card-save-btn" data-test="settings-save-stalwart" @click="onSaveStalwart">保存</UButton>
      </UCard>

      <!-- 卡三：通知发信（SMTP）；独立开关/测试/保存（#340）；动线 #99：表单常显、测试恒可用 -->
      <UCard class="settings-card" data-test="settings-card-smtp">
        <div class="mail-card-head">
          <h2 class="section-title">通知发信（SMTP）</h2>
          <!-- #99：开关纯表单字段恒可切 -->
          <USwitch
            :model-value="smtpEnabled"
            aria-label="通知发信开关"
            data-test="settings-switch-smtp"
            @update:model-value="onSmtpSwitch"
          />
        </div>
        <p v-if="!smtpEnabled" class="mail-switch-hint">
          关闭后实例不再发送通知邮件；已存配置保留，重新开启无需重填
        </p>

        <!-- #99：配置区常显（无折叠——关态也可改配置、测试） -->
        <div class="smtp-config" data-test="smtp-config">
          <div class="settings-grid">
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
          </div>

          <!-- #99：测试恒可用（候选化探测不依赖开关状态）；缺字段由后端回人话结果 -->
          <UButton
            variant="outline"
            :loading="smtpTesting"
            class="test-btn"
            data-test="settings-test-smtp"
            @click="onTestSmtp"
          >
            测试连接
          </UButton>
          <p v-if="smtpTestError" class="form-alert" role="alert">{{ smtpTestError }}</p>
          <div v-if="smtpTest" class="mail-test-results" role="status">
            <div class="mail-test-card" :class="smtpTest.ok ? 'is-ok' : 'is-fail'">
              <strong>{{ smtpTest.ok ? '成功' : '失败' }}</strong>
              <span>{{ smtpTest.detail }}</span>
            </div>
          </div>
        </div>

        <!-- 卡内保存（#340）：各卡独立提交（开关+字段一次落库） -->
        <p v-if="smtpSaveError" class="form-alert" role="alert">{{ smtpSaveError }}</p>
        <p v-else-if="smtpSaved" class="save-ok" role="status">已保存</p>
        <UButton :loading="smtpSaving" class="card-save-btn" data-test="settings-save-smtp" @click="onSaveSmtp">保存</UButton>
      </UCard>
    </template>
  </div>
</template>

<style scoped>
@import './page.css';

.settings-card {
  margin-bottom: var(--unself-space-4);
}
/* 邮件两卡头部：标题 + 开关一行（开关 aria-label 独立于可见标题） */
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
/* #340：卡内保存（各卡独立提交） */
.card-save-btn {
  margin-top: var(--unself-space-3);
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
