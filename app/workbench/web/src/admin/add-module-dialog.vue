<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 「新增模块」双模式弹窗（#349 决策 #108/#109）。
 *
 * 壳（遮罩/标题栏/✕/焦点三契约/装饰水面/入场动画）沿用设置页水舱弹窗同一外壳，已收进
 * components/aqua-dialog.vue（#349 消融：外壳一次编写，两个弹窗共用）。
 * 动线与设置弹窗同款（#99/#100）：测试连接 → 保存；水位随测试状态联动
 * （testing→波动、在线→满灌、其余→静息；仅反连 tab 出水，纯装饰恒 aria-hidden）。
 * 两种模式是两个 tab，不共用状态机：
 * - 反连（connect）：生成接入码（问号收进按钮，UNSELF_CORE_URL 说明走其 hover/focus tooltip）→ 生成即复制
 *   （明文立刻进剪贴板）→ env 展示框**默认打码**（点框=复制明文；右侧内嵌眼睛切打码/明文）→ 测试连接（查隧道在线）
 *   → 保存（激活记账行）。壳从不持有明文 key 的常驻视图：打码是默认，明文只活在剪贴板与显式的显示态（#349 验收定案）。
 * - CF 部署：npm 规格 + CF token + 账号 → 一次请求完成部署与注册（token 用后即焚，#165）。
 *
 * 为什么不做「模式一先测试再保存」：运行时装配本身就是部署动作（拉包→校验→上传），
 * 没有「半成品可保存态」；失败即什么都没发生，重试即重跑（决策 #109 的语义）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { CircleHelp, Eye, EyeOff } from 'lucide-vue-next'

import { UButton, UMotionSelect, type SelectOption } from '@unself/ui'

import AquaDialog from '../components/aqua-dialog.vue'

import {
  activateConnectModule,
  fetchConnectStatus,
  generateConnectKey,
  installCloudflareModule,
  registerConnectModule,
} from '../lib/modules-install-api'
import { fetchAdminModules } from '../lib/admin-api'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** 保存/部署成功：页面刷新列表。 */
  done: []
}>()

/** 可写 computed：壳内 Esc / ✕ 关闭走 update:modelValue（ConfirmDialog 同款）。 */
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

type Tab = 'connect' | 'cloudflare'

const tab = ref<Tab>('connect')
const errorText = ref<string | null>(null)
const busy = ref(false)

// ---- 反连模式状态 ----
const connectId = ref('')
/** 已生成的接入码（明文只在本次开窗内可见；关闭即清）。 */
const connectKey = ref<string | null>(null)
const connectStatus = ref<'idle' | 'testing' | 'online' | 'offline'>('idle')
/**
 * 上一次测试通过时的输入快照（id + 存储落点）。
 * 绿只是「那一刻的 id 绿」：id/落点一变即失效，必须对当前输入重测才能保存（不能只看一个全局 online）。
 */
const testedSnapshot = ref<string | null>(null)
const connectSnapshot = computed(() => JSON.stringify([connectId.value.trim(), connectStorage.value]))
/** env 区默认打码；右侧内嵌眼睛是显式切换，明文只在此刻渲染进 DOM。 */
const keyVisible = ref(false)
/** 接入码展示框，降级复制时选中它，不靠全局 querySelector。 */
const envEl = ref<HTMLElement | null>(null)
/** 复制反馈：「已复制」约 2s；不透明 span 稳定占位，测试不查瞬时 DOM。 */
const copied = ref(false)
/** clipboard 不可用 / 被拒（纯 http 等）→ 降级：选中文本让用户手动 Ctrl+C。 */
const copyFallback = ref(false)
/** UNSELF_CORE_URL 说明 tooltip：hover / focus 时可见。 */
const coreUrlTip = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

// ---- 模式一状态 ----
const npmSpec = ref('')
const cfToken = ref('')
const accountId = ref('')

// 存储落点收敛为两档：core（经核心代理）/ self（自托管，默认）。undefined 即 self（#349 验收定案）；
// AdminModule['storage_level'] 契约尚未并入 'self'（另一 worker 负责契约层 enum('core','self')），先用本地类型
const storageOptions: SelectOption[] = [
  { value: 'self', label: '自托管' },
  { value: 'core', label: 'Core' },
]
const connectStorageOptions = storageOptions
const cfStorageOptions = storageOptions

/** 本组件的存储落点取值：契约层收敛期间，'self' 用 undefined（=默认）承载。 */
type StorageChoice = 'core' | 'self'
const connectStorage = ref<StorageChoice>('self')
const cfStorage = ref<StorageChoice>('self')

/** 展示行：默认打码占位，显示态才渲染明文。 */
const envLines = computed(() => [`UNSELF_MODULE_KEY=${keyVisible.value ? connectKey.value : '••••••••'}`])
const envText = computed(() => envLines.value.join('\n'))

const canTest = computed(() => Boolean(connectKey.value) && !busy.value)
const canSave = computed(
  () => connectStatus.value === 'online' && testedSnapshot.value === connectSnapshot.value && !busy.value,
)
const canInstall = computed(() => Boolean(npmSpec.value.trim() && cfToken.value.trim() && accountId.value.trim()) && !busy.value)

/** 水位派生（设置弹窗同款，#100）：反连 tab 才有水；testing→波动、在线→满灌、其余→静息。 */
const waveLevel = computed(() => {
  if (tab.value !== 'connect') return 'rest'
  if (connectStatus.value === 'testing') return 'testing'
  return connectStatus.value === 'online' ? 'full' : 'rest'
})

/** 输入一变，上一轮测试结果（含 testing 中的旧请求）立即作废，保存按钮随之禁用。 */
watch(connectSnapshot, () => {
  testedSnapshot.value = null
  connectStatus.value = 'idle'
})

/** 换 tab / 关窗都清结果态（重开回到初始态，#100 同规）。 */
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorText.value = null
      connectStatus.value = 'idle'
    } else {
      // 明文 key 只在本窗存活：关闭即丢弃（不写 localStorage / sessionStorage）
      connectKey.value = null
      cfToken.value = ''
      connectStatus.value = 'idle'
      testedSnapshot.value = null
      keyVisible.value = false
      copied.value = false
      copyFallback.value = false
      coreUrlTip.value = false
      if (copyTimer !== undefined) clearTimeout(copyTimer)
    }
  },
)

async function onGenerate(): Promise<void> {
  errorText.value = null
  const moduleId = connectId.value.trim()
  if (!/^[a-z][a-z0-9-]+$/.test(moduleId)) {
    errorText.value = '模块 id 只能用小写字母、数字与连字符，且以字母开头'
    return
  }
  busy.value = true
  try {
    // id 不得与已有模块重名：先问管理端列表（拿不到就交给服务端 409 兜底）
    const existing = (await fetchAdminModules().catch(() => [])) ?? []
    if (existing.some((m) => m.id === moduleId)) {
      errorText.value = moduleIdTakenMessage(moduleId)
      return
    }
    const { key, keyHash } = await generateConnectKey()
    await registerConnectModule({
      moduleId,
      keyHash,
      storageLevel: connectStorage.value === 'core' ? 'core' : undefined,
    })
    connectKey.value = key
    keyVisible.value = false
    copied.value = false
    copyFallback.value = false
    connectStatus.value = 'idle'
    // 生成即复制（#349 验收定案）：明文 key 立刻进剪贴板，用户不必再找复制按钮
    await copyKey()
  } catch (err) {
    errorText.value = isIdTaken(err) ? moduleIdTakenMessage(moduleId) : (err as Error).message
  } finally {
    busy.value = false
  }
}

/** 409 = 服务端说这个 id 已存在；给人话，不回显状态码。 */
function isIdTaken(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 409
}

function moduleIdTakenMessage(moduleId: string): string {
  return `这个模块 id 已经有了（${moduleId}），换一个再生成`
}

/** 复制明文 key：成功→「已复制」约 2s；失败（纯 http / 权限被拒）→ 选中 env 文本提示手动 Ctrl+C。 */
async function copyKey(): Promise<void> {
  if (!connectKey.value) return
  try {
    await navigator.clipboard.writeText(connectKey.value)
    copied.value = true
    copyFallback.value = false
    if (copyTimer !== undefined) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // 纯 http / 权限被拒：先亮出明文再选中，否则 Ctrl+C 拿到的是打码圆点。
    keyVisible.value = true
    copyFallback.value = true
    copied.value = false
    await nextTick()
    selectEnvText()
  }
}

function selectEnvText(): void {
  const node = envEl.value
  if (!node) return
  document.getSelection()?.selectAllChildren(node)
}

function onToggleKey(): void {
  keyVisible.value = !keyVisible.value
}

async function onTest(): Promise<void> {
  errorText.value = null
  const moduleId = connectId.value.trim()
  const snapshot = connectSnapshot.value
  connectStatus.value = 'testing'
  try {
    const status = await fetchConnectStatus(moduleId)
    // 测试期间输入又变了：结果属于旧 id，丢弃（watch 已把状态打回 idle）
    if (connectSnapshot.value !== snapshot) return
    connectStatus.value = status.online ? 'online' : 'offline'
    testedSnapshot.value = status.online ? snapshot : null
    if (!status.online) {
      errorText.value = '模块还没连上来：确认模块已按 env 启动并保持运行'
    }
  } catch (err) {
    if (connectSnapshot.value !== snapshot) return
    connectStatus.value = 'offline'
    testedSnapshot.value = null
    errorText.value = (err as Error).message
  }
}

async function onSave(): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    await activateConnectModule(connectId.value.trim())
    emit('done')
    close()
  } catch (err) {
    errorText.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function onInstall(): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    await installCloudflareModule({
      npmSpec: npmSpec.value.trim(),
      cfToken: cfToken.value.trim(),
      accountId: accountId.value.trim(),
      storageLevel: cfStorage.value === 'core' ? 'core' : undefined,
    })
    emit('done')
    close()
  } catch (err) {
    errorText.value = (err as Error).message
  } finally {
    // 会话内凭证：无论成败都不留在组件状态里（#165）
    cfToken.value = ''
    busy.value = false
  }
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <AquaDialog v-model="open" title="新增模块" name="add-module-dialog" :level="waveLevel" max-width="560px">
    <div class="add-dialog-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="add-dialog-tab"
        :class="{ 'is-active': tab === 'connect' }"
        :aria-selected="tab === 'connect'"
        data-test="add-module-tab-connect"
        @click="tab = 'connect'"
      >
        反连接入
      </button>
      <button
        type="button"
        role="tab"
        class="add-dialog-tab"
        :class="{ 'is-active': tab === 'cloudflare' }"
        :aria-selected="tab === 'cloudflare'"
        data-test="add-module-tab-cloudflare"
        @click="tab = 'cloudflare'"
      >
        Cloudflare 部署
      </button>
    </div>

    <!-- 反连：模块自己拨号回家，NAT 后也能接（决策 #108） -->
    <div v-if="tab === 'connect'" class="add-dialog-fields" data-test="add-module-connect">
      <label class="add-field">
        <span class="add-field-label">模块 id</span>
        <input v-model="connectId" class="add-field-input" data-test="connect-id" placeholder="如 bridge" />
      </label>
      <div class="add-field">
        <span class="add-field-label" id="connect-storage-label">存储落点</span>
        <UMotionSelect
          v-model="connectStorage"
          :options="connectStorageOptions"
          label="存储落点"
          aria-labelledby="connect-storage-label"
          placeholder="自托管"
          data-test="connect-storage"
        />
      </div>

      <span v-if="!connectKey" class="add-help-row">
        <UButton
          variant="outline"
          :loading="busy"
          data-test="connect-generate"
          aria-describedby="core-url-tip"
          @click="onGenerate"
          @focus="coreUrlTip = true"
          @blur="coreUrlTip = false"
          @mouseenter="coreUrlTip = true"
          @mouseleave="coreUrlTip = false"
        >
          <!-- 问号收进生成按钮（#349 验收定案）：UNSELF_CORE_URL 说明只挂它的 hover/focus -->
          <CircleHelp aria-hidden="true" :size="16" />
          生成接入码
        </UButton>
        <span v-show="coreUrlTip" id="core-url-tip" role="tooltip" class="add-tooltip" data-test="connect-env-help-tip">
          模块 env 另需 UNSELF_CORE_URL=core 的可达地址
        </span>
      </span>

      <template v-else>
        <!-- 展示框本体=复制（生成已自动复制过一次，点框补手动）；右侧内嵌眼睛切打码/明文 -->
        <div class="add-env-box">
          <pre
            ref="envEl"
            class="add-dialog-env"
            data-test="connect-env"
            role="button"
            tabindex="0"
            aria-label="接入码 env：点击复制"
            @click="copyKey"
            @keydown.enter.prevent="copyKey"
            @keydown.space.prevent="copyKey"
          >{{ envText }}</pre>
          <button
            type="button"
            class="add-env-eye"
            :aria-pressed="keyVisible"
            :aria-label="keyVisible ? '隐藏接入码' : '显示接入码'"
            data-test="connect-toggle-key"
            @click="onToggleKey"
          >
            <Eye v-if="!keyVisible" aria-hidden="true" :size="16" />
            <EyeOff v-else aria-hidden="true" :size="16" />
          </button>
        </div>
        <!-- 稳定占位：复制 / 降级反馈共用一个不透明 span，测试不查瞬时 DOM -->
        <span class="add-env-feedback" data-test="connect-copy-feedback" aria-live="polite">
          {{ copied ? '已复制' : copyFallback ? '已选中 env：请按 Ctrl+C 复制' : '' }}
        </span>
      </template>
    </div>

    <!-- 模式一：core 运行时拉包部署（装配后增补单模块，决策 #109） -->
    <div v-else class="add-dialog-fields" data-test="add-module-cloudflare">
      <label class="add-field">
        <span class="add-field-label">npm 包</span>
        <input v-model="npmSpec" class="add-field-input" data-test="cf-npmspec" placeholder="@unself/hello@0.1.0" />
      </label>
      <label class="add-field">
        <span class="add-field-label">Cloudflare 账号 ID</span>
        <input v-model="accountId" class="add-field-input" data-test="cf-account" placeholder="32 位十六进制" />
      </label>
      <label class="add-field">
        <span class="add-field-label">API Token（用后即焚）</span>
        <input v-model="cfToken" type="password" class="add-field-input" data-test="cf-token" autocomplete="off" />
      </label>
      <div class="add-field">
        <span class="add-field-label" id="cf-storage-label">存储落点</span>
        <UMotionSelect
          v-model="cfStorage"
          :options="cfStorageOptions"
          label="存储落点"
          aria-labelledby="cf-storage-label"
          placeholder="自托管"
          data-test="cf-storage"
        />
      </div>
    </div>

    <p v-if="errorText" class="add-dialog-alert" role="alert" data-test="add-module-alert">{{ errorText }}</p>
    <p v-else-if="connectStatus === 'online'" class="add-dialog-status" role="status" data-test="add-module-status">
      模块已连上来（隧道在线）
    </p>

    <footer class="add-actions-row">
      <template v-if="tab === 'connect'">
        <UButton variant="outline" :disabled="!canTest" :loading="connectStatus === 'testing'" data-test="connect-test" @click="onTest">
          测试连接
        </UButton>
        <UButton variant="primary" :disabled="!canSave" :loading="busy" data-test="connect-save" @click="onSave">
          保存
        </UButton>
      </template>
      <UButton v-else variant="primary" :disabled="!canInstall" :loading="busy" data-test="cf-install" @click="onInstall">
        部署并注册
      </UButton>
    </footer>
  </AquaDialog>
</template>

<style scoped>
.add-dialog-tabs {
  position: relative;
  z-index: 1;
  display: flex;
  gap: var(--unself-space-2);
  border-bottom: 1px solid var(--unself-color-border);
}
.add-dialog-tab {
  padding: var(--unself-space-2) var(--unself-space-3);
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  cursor: pointer;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-base);
}
.add-dialog-tab.is-active {
  border-bottom-color: var(--unself-color-primary);
  color: var(--unself-color-text);
  font-weight: 500;
}
.add-dialog-fields {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}
.add-field {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-1);
}
.add-field-label {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.add-field-input {
  height: 40px;
  padding: 0 var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-base);
}
.add-env-box {
  position: relative;
}
.add-dialog-env {
  margin: 0;
  padding: var(--unself-space-3);
  padding-right: calc(28px + var(--unself-space-3));
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  font-size: var(--unself-font-size-sm);
  white-space: pre-wrap;
  word-break: break-all;
  cursor: pointer;
}
.add-dialog-env:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.add-env-feedback {
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.add-help-row {
  position: relative;
  z-index: 0;
  display: flex;
  width: 100%;
}
.add-help-row :deep(button) {
  width: 100%;
  justify-content: center;
}
.add-env-eye {
  position: absolute;
  top: 50%;
  right: var(--unself-space-2);
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--unself-radius-full);
  background: none;
  cursor: pointer;
  color: var(--unself-color-text-secondary);
}
.add-env-eye:hover {
  color: var(--unself-color-text);
}
.add-env-eye:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.add-tooltip {
  position: absolute;
  top: calc(100% + var(--unself-space-2));
  left: 0;
  z-index: 1;
  width: max-content;
  max-width: 320px;
  padding: var(--unself-space-2) var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-surface);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-sm);
  box-shadow: var(--unself-shadow-pop);
}
.add-dialog-alert {
  position: relative;
  z-index: 1;
  margin: 0;
  color: var(--unself-color-danger);
  font-size: var(--unself-font-size-sm);
}
.add-dialog-status {
  position: relative;
  z-index: 1;
  margin: 0;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
}
.add-actions-row {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: flex-end;
  gap: var(--unself-space-3);
}
</style>
