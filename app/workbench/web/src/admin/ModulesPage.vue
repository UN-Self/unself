<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, computed } from 'vue'

import { UButton, UErrorCard, USkeleton, UInput, UMotionSelect, USwitch } from '@unself/ui'

import {
  fetchAdminModules,
  fetchModuleConfig,
  saveModuleConfig,
  toggleModule,
  type AdminModule,
  type ModuleConfigField,
} from '../lib/admin-api'
import { fetchConnectStatus, removeModule } from '../lib/modules-install-api'
import { useAsyncLoad } from '../lib/use-async-load'
import AddModuleDialog from './add-module-dialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

/**
 * 管理台模块页（#17）：全量列表（含停用）+ 启停开关。
 * 停用中的模块也显示（#77 部署器遗留诉求的界面闭环）。
 * U7（#349）：反连行内「测试」按钮（点击才测）。
 * U8（#349）：manifest.config 非空的行内「设置」表单（行展开，无弹窗）。
 * U10（#349）：行内「移除」——站内 danger 确认（#192 F6 同款基元）后才 DELETE；确认文案人话说明接入码作废。
 */

// #142：加载三态样板收编 use-async-load（phase/loadError 变量名不变，模板零改动）
const { phase, loadError, data: modules, load } = useAsyncLoad<AdminModule[]>(fetchAdminModules, { initial: [] })
const busyId = ref<string | null>(null)
const actionError = ref<string | null>(null)
/** 「新增模块」弹窗（#349 双模式）：成功即重取列表（部署/激活都在服务端落库）。 */
const addOpen = ref(false)

function onModuleAdded(): void {
  void load()
}

/** 启停直接生效（注册表开关秒级可见；无 confirm——动作可逆）。 */
async function onToggle(mod: AdminModule): Promise<void> {
  busyId.value = mod.id
  actionError.value = null
  try {
    await toggleModule(mod.id, !mod.enabled)
    mod.enabled = !mod.enabled
  } catch (err) {
    actionError.value = (err as Error).message
  } finally {
    busyId.value = null
  }
}

/** 存储列显示收敛（#349 U7）：值→文案映射两头都认——旧 shared/dedicated→Core、legacy self→自托管；''/null→自托管。 */
const STORAGE_LEVEL_LABELS: Record<string, string> = {
  core: 'Core',
  self: '自托管',
  dedicated: 'Core',
  shared: 'Core',
  external: '自托管',
  '': '自托管',
}

function storageLabel(level: AdminModule['storage_level']): string {
  return STORAGE_LEVEL_LABELS[level ?? ''] ?? '自托管'
}

/** 行内「测试」结果（#349 U7）：仅 mode='connect' 行有测试动作；点按钮才测，不轮询不自动测。 */
const testStatus = ref<Record<string, { online: boolean; reason?: string }>>({})
/** 测试中：按钮 loading（UButton loading 自带禁用）；同一时刻一行一个测试。 */
const testingId = ref<string | null>(null)

async function onTestConnection(mod: AdminModule): Promise<void> {
  testingId.value = mod.id
  try {
    const status = await fetchConnectStatus(mod.id)
    testStatus.value[mod.id] = { online: status.online, reason: status.reason }
  } catch {
    // 请求失败也按离线落行内结果（可重点击重测，不弹窗）
    testStatus.value[mod.id] = { online: false, reason: '测试请求失败，模块可能离线' }
  } finally {
    testingId.value = null
  }
}

// ---- U8（#349）：行内设置表单（manifest.config 暴露才有入口；行展开不弹窗） ----

/** 该模块有没有暴露配置项（manifest 快照损坏 = 无，fail-closed）。 */
function exposesConfig(mod: AdminModule): boolean {
  return Array.isArray(mod.manifest?.config) && mod.manifest!.config.length > 0
}

/** 一次只开一行的展开态；null = 全部收起。 */
const configOpenId = ref<string | null>(null)
const configLoading = ref(false)
const configBusy = ref(false)
const configError = ref<string | null>(null)
/** 服务端回的字段声明与当前值（secret 已打码，仅用于「已设置」提示）。 */
const configFields = ref<ModuleConfigField[]>([])
const configValues = ref<Record<string, unknown>>({})
/**
 * 表单草稿：string/secret/number/url/json → 输入框原始串；boolean → 布尔；enum → 选中串。
 * secret 恒从空输入起步（服务端打码值不回填），保存时空 = '***' = 保持不变。
 */
const configDraft = ref<Record<string, string | boolean>>({})

function draftString(key: string): string {
  const v = configDraft.value[key]
  return typeof v === 'string' ? v : ''
}

function draftPlaceholder(field: ModuleConfigField): string | undefined {
  if (field.type !== 'secret') return undefined
  return configValues.value[field.key] === '***' ? '已设置，留空保持不变' : '留空保持不变'
}

function enumOptions(field: ModuleConfigField): Array<{ value: string; label: string }> {
  return (field.options ?? []).map((o) => ({ value: o, label: o }))
}

/** 点「设置」：展开并拉取服务端配置态（再点收起）；失败落行内 role=alert。 */
async function onOpenSettings(mod: AdminModule): Promise<void> {
  if (configOpenId.value === mod.id) {
    configOpenId.value = null
    return
  }
  configOpenId.value = mod.id
  configLoading.value = true
  configError.value = null
  try {
    const state = await fetchModuleConfig(mod.id)
    configFields.value = state.config
    configValues.value = state.values
    const draft: Record<string, string | boolean> = {}
    for (const field of state.config) {
      const v = state.values[field.key]
      if (field.type === 'boolean') draft[field.key] = v === true
      else if (field.type === 'secret') draft[field.key] = ''
      else draft[field.key] = v === undefined || v === null ? '' : String(v)
    }
    configDraft.value = draft
  } catch (err) {
    configError.value = (err as Error).message
    configFields.value = []
    configValues.value = {}
  } finally {
    configLoading.value = false
  }
}

function onCancelSettings(): void {
  configOpenId.value = null
  configError.value = null
}

/** 草稿 → PUT values：secret 空 = '***'（保持）；空串省略交服务端按 required 判。 */
function buildValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of configFields.value) {
    const raw = configDraft.value[field.key]
    if (field.type === 'boolean') {
      values[field.key] = raw === true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (field.type === 'secret') {
      values[field.key] = text === '' ? '***' : text
      continue
    }
    if (text === '') continue
    values[field.key] = field.type === 'number' ? Number(text) : text
  }
  return values
}

/** 存配置失败：成功收起面板；失败行内提示（面板不收，草稿保留可改）。 */
async function onSaveSettings(mod: AdminModule): Promise<void> {
  configBusy.value = true
  configError.value = null
  try {
    await saveModuleConfig(mod.id, buildValues())
    configOpenId.value = null
  } catch (err) {
    configError.value = (err as Error).message
  } finally {
    configBusy.value = false
  }
}

// ---- U10（#349）：行内「移除」（站内 danger 确认后才 DELETE；一次只挂一行） ----

/** 确认弹层开合 + 目标行（目标即真值，开合派生——MembersPage 同款）。 */
const removeTarget = ref<AdminModule | null>(null)
const removeOpen = computed({
  get: () => removeTarget.value !== null,
  set: (open: boolean) => {
    if (!open) removeTarget.value = null
  },
})

function onRemove(mod: AdminModule): void {
  removeTarget.value = mod
}

/** 确认后 DELETE：成功从列表移除该行；失败行内 role=alert（不静默，弹层已关）。 */
async function onRemoveConfirm(): Promise<void> {
  const mod = removeTarget.value
  if (!mod) return
  removeTarget.value = null
  actionError.value = null
  try {
    await removeModule(mod.id)
    modules.value = modules.value.filter((m) => m.id !== mod.id)
  } catch (err) {
    actionError.value = (err as Error).message
  }
}
</script>

<template>
  <div>
    <header class="page-head">
      <h1 class="page-title">模块</h1>
      <UButton variant="primary" size="sm" data-test="add-module" @click="addOpen = true">
        新增模块
      </UButton>
    </header>

    <AddModuleDialog v-model="addOpen" @done="onModuleAdded" />

    <USkeleton v-if="phase === 'loading'" class="page-skeleton" />

    <UErrorCard
      v-else-if="phase === 'error'"
      title="模块列表加载失败"
      :message="loadError?.message"
      :request-id="loadError?.requestId"
      :detail="loadError?.detail"
    />

    <div v-else class="module-list">
      <p v-if="actionError" class="form-alert" role="alert">{{ actionError }}</p>

      <p v-if="modules.length === 0" class="page-empty">还没有注册模块（部署脚本装配后出现在这里）</p>

      <template v-for="mod in modules" :key="mod.id">
        <div class="module-row" data-test="module-row">
        <div class="module-id">
          {{ mod.id }}
          <span v-if="mod.version" class="module-version">v{{ mod.version }}</span>
          <!-- #348 落点三列（决策 #107 最小消费面）：纯文本展示，徽章视觉属 D3 -->
          <span class="module-provisioning" data-test="module-provisioning">
            落点 {{ mod.mode }} · 存储 {{ storageLabel(mod.storage_level) }}<template v-if="mod.mode === 'connect' && mod.entry"> · 接入 {{ mod.entry }}</template>
          </span>
        </div>
        <span class="badge" :class="mod.enabled ? 'badge-ok' : 'badge-muted'">
          {{ mod.enabled ? '启用中' : '已停用' }}
        </span>
        <span
          v-if="testStatus[mod.id]"
          class="badge"
          :class="testStatus[mod.id]!.online ? 'badge-ok' : 'badge-warn'"
          data-test="connect-status"
          :title="testStatus[mod.id]!.online ? undefined : testStatus[mod.id]!.reason"
        >
          {{ testStatus[mod.id]!.online ? '在线' : '离线' }}
        </span>
        <UButton
          v-if="mod.mode === 'connect'"
          variant="outline"
          size="sm"
          :loading="testingId === mod.id"
          data-test="test-connection"
          @click="onTestConnection(mod)"
        >
          测试
        </UButton>
        <span v-else class="module-noop" data-test="test-connection-empty">—</span>
        <!-- U8：manifest.config 暴露才有「设置」；没暴露就没有（数据驱动，不按模块名硬编码） -->
        <UButton
          v-if="exposesConfig(mod)"
          variant="outline"
          size="sm"
          data-test="module-settings"
          @click="onOpenSettings(mod)"
        >
          设置
        </UButton>
        <span v-else class="module-noop" data-test="module-settings-empty">—</span>
        <UButton
          :variant="mod.enabled ? 'outline' : 'primary'"
          size="sm"
          :disabled="busyId !== null"
          @click="onToggle(mod)"
        >
          {{ mod.enabled ? '停用' : '启用' }}
        </UButton>
        <!-- U10：移除 = 注册表删行（不可逆），先站内确认再 DELETE -->
        <UButton variant="outline" size="sm" data-test="module-remove" @click="onRemove(mod)">
          移除
        </UButton>
        </div>
        <!-- U8 行展开设置面板（一次一行；configLoading 拉取中不渲染字段） -->
        <div
          v-if="configOpenId === mod.id"
          class="module-config"
          data-test="module-config-panel"
        >
        <p v-if="configError" class="form-alert" role="alert" data-test="config-error">{{ configError }}</p>
        <p v-if="configLoading" class="module-config-loading">加载中…</p>
        <template v-else>
          <div
            v-for="field in configFields"
            :key="field.key"
            class="module-config-field"
            :data-test="`config-field-${field.key}`"
          >
            <!-- oauth：不渲染控件，人话提示（部署端动作） -->
            <template v-if="field.type === 'oauth'">
              <span class="module-config-label">{{ field.label }}</span>
              <span class="module-config-hint" data-test="config-oauth-hint">该模块配置项需在部署端完成</span>
            </template>
            <!-- boolean：开关基元 -->
            <label v-else-if="field.type === 'boolean'" class="module-config-boolean">
              <USwitch
                :model-value="configDraft[field.key] === true"
                :data-test="`config-input-${field.key}`"
                @update:model-value="(v: boolean) => (configDraft[field.key] = v)"
              />
              <span class="module-config-label">{{ field.label }}</span>
            </label>
            <!-- enum：选基元 -->
            <UMotionSelect
              v-else-if="field.type === 'enum'"
              :model-value="draftString(field.key)"
              :options="enumOptions(field)"
              :label="field.label"
              :placeholder="field.required ? '必选' : '未选择'"
              :data-test="`config-input-${field.key}`"
              @update:model-value="(v: string | null) => (configDraft[field.key] = v ?? '')"
            />
            <!-- 其余四类走输入框（number/url/json/text 同型；secret 折叠为密码框） -->
            <UInput
              v-else
              :model-value="draftString(field.key)"
              :label="field.label"
              :type="field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text'"
              :placeholder="draftPlaceholder(field)"
              :required="field.required"
              :data-test="`config-input-${field.key}`"
              @update:model-value="(v: string) => (configDraft[field.key] = v)"
            />
            <!-- json 人话提示 -->
            <span v-if="field.type === 'json'" class="module-config-hint">填 JSON 文本</span>
          </div>
          <div class="module-config-actions">
            <UButton
              variant="primary"
              size="sm"
              :loading="configBusy"
              data-test="config-save"
              @click="onSaveSettings(mod)"
            >
              保存
            </UButton>
            <UButton variant="outline" size="sm" data-test="config-cancel" @click="onCancelSettings">
              取消
            </UButton>
          </div>
        </template>
        </div>
      </template>
    </div>

    <!-- U10 移除二次确认（#192 F6：站内确认替代 window.confirm；不可逆动作 danger 档） -->
    <ConfirmDialog
      v-model="removeOpen"
      kind="danger"
      title="移除模块"
      :message="removeTarget ? `移除 ${removeTarget.id} 后接入码立即作废` : ''"
      confirm-label="移除"
      @confirm="onRemoveConfirm"
    />
  </div>
</template>

<style scoped>
@import './page.css';

.module-list {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-2);
}
.module-list > .module-row {
  display: flex;
  align-items: center;
  gap: var(--unself-space-3);
  padding: var(--unself-space-3) var(--unself-space-4);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-bg);
}
.module-id {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.module-version {
  margin-left: var(--unself-space-2);
  font-size: var(--unself-font-size-xs);
  font-weight: 400;
  color: var(--unself-color-text-tertiary);
}
.module-provisioning {
  display: block;
  margin-top: var(--unself-space-1);
  font-size: var(--unself-font-size-xs);
  font-weight: 400;
  color: var(--unself-color-text-tertiary);
}
.module-noop {
  color: var(--unself-color-text-tertiary);
}
/* U8 行内设置面板（行展开；样式全 tokens） */
.module-config {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
  margin: 0 var(--unself-space-4) var(--unself-space-3);
  padding: var(--unself-space-3) var(--unself-space-4);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
}
.module-config-field {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
  max-width: 480px;
}
.module-config-boolean {
  display: flex;
  align-items: center;
  gap: var(--unself-space-2);
}
.module-config-label {
  font-size: var(--unself-font-size-sm);
  font-weight: 500;
  color: var(--unself-color-text);
}
.module-config-hint {
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-text-tertiary);
}
.module-config-loading {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.module-config-actions {
  display: flex;
  gap: var(--unself-space-2);
}
</style>
