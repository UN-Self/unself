<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 「新增模块」双模式弹窗（#349 决策 #108/#109）。
 *
 * 壳沿用设置页水舱弹窗的同一套外壳与动线（#99/#100）：测试连接 → 保存；水位仍纯装饰。
 * 两种模式是两个 tab，不共用状态机：
 * - 反连（connect）：生成接入码 → 展示 env 两行（**明文只此一次**）→ 测试连接（查隧道在线）
 *   → 保存（激活记账行）。壳从不持有明文 key：只有 SHA-256 哈希过网（决策 #108）。
 * - CF 部署：npm 规格 + CF token + 账号 → 一次请求完成部署与注册（token 用后即焚，#165）。
 *
 * 为什么不做「模式一先测试再保存」：运行时装配本身就是部署动作（拉包→校验→上传），
 * 没有「半成品可保存态」；失败即什么都没发生，重试即重跑（决策 #109 的语义）。
 */
import { computed, ref, watch } from 'vue'

import { UButton } from '@unself/ui'

import {
  activateConnectModule,
  fetchConnectStatus,
  generateConnectKey,
  installCloudflareModule,
  registerConnectModule,
} from '../lib/modules-install-api'
import type { AdminModule } from '../lib/admin-api'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** 保存/部署成功：页面刷新列表。 */
  done: []
}>()

type Tab = 'connect' | 'cloudflare'

const tab = ref<Tab>('connect')
const errorText = ref<string | null>(null)
const busy = ref(false)

// ---- 反连模式状态 ----
const connectId = ref('')
const connectStorage = ref<'' | NonNullable<AdminModule['storage_level']>>('')
/** 已生成的接入码（明文只在本次开窗内可见；关闭即清）。 */
const connectKey = ref<string | null>(null)
const connectStatus = ref<'idle' | 'testing' | 'online' | 'offline'>('idle')

// ---- 模式一状态 ----
const npmSpec = ref('')
const cfToken = ref('')
const accountId = ref('')
const cfStorage = ref<'' | NonNullable<AdminModule['storage_level']>>('')

const coreUrl = computed(() => (typeof window === 'undefined' ? '' : window.location.origin))
const envLines = computed(() => [
  `UNSELF_CORE_URL=${coreUrl.value}`,
  `UNSELF_MODULE_KEY=${connectKey.value ?? ''}`,
  `UNSELF_MODULE_ID=${connectId.value}`,
])

const canTest = computed(() => Boolean(connectKey.value) && !busy.value)
const canSave = computed(() => connectStatus.value === 'online' && !busy.value)
const canInstall = computed(() => Boolean(npmSpec.value.trim() && cfToken.value.trim() && accountId.value.trim()) && !busy.value)

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
    const { key, keyHash } = await generateConnectKey()
    await registerConnectModule({
      moduleId,
      keyHash,
      storageLevel: connectStorage.value === '' ? undefined : connectStorage.value,
    })
    connectKey.value = key
    connectStatus.value = 'idle'
  } catch (err) {
    errorText.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function onTest(): Promise<void> {
  errorText.value = null
  connectStatus.value = 'testing'
  try {
    const status = await fetchConnectStatus(connectId.value.trim())
    connectStatus.value = status.online ? 'online' : 'offline'
    if (!status.online) {
      errorText.value = '模块还没连上来：确认模块已按上面两行 env 启动并保持运行'
    }
  } catch (err) {
    connectStatus.value = 'offline'
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
      storageLevel: cfStorage.value === '' ? undefined : cfStorage.value,
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
  <div v-if="modelValue" class="add-dialog-scrim" @click.self="close">
    <section
      class="add-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="新增模块"
      data-test="add-module-dialog"
      @click.stop
    >
      <header class="add-dialog-head">
        <h2 class="add-dialog-title">新增模块</h2>
        <button type="button" class="add-dialog-close" aria-label="关闭" data-test="add-module-close" @click="close">
          ✕
        </button>
      </header>

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
        <label class="add-field">
          <span class="add-field-label">存储落点（可选）</span>
          <select v-model="connectStorage" class="add-field-input" data-test="connect-storage">
            <option value="">不指定</option>
            <option value="core">core（经核心代理）</option>
            <option value="shared">shared（共享库）</option>
            <option value="dedicated">dedicated（核心代供）</option>
            <option value="external">external（模块自备）</option>
          </select>
        </label>

        <UButton
          v-if="!connectKey"
          variant="outline"
          :loading="busy"
          data-test="connect-generate"
          @click="onGenerate"
        >
          生成接入码
        </UButton>

        <template v-else>
          <p class="add-dialog-hint" data-test="connect-key-notice">
            这串接入码只显示这一次，关闭后不可再查看。请写入模块的 env：
          </p>
          <pre class="add-dialog-env" data-test="connect-env">{{ envLines.join('\n') }}</pre>
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
        <label class="add-field">
          <span class="add-field-label">存储落点（可选）</span>
          <select v-model="cfStorage" class="add-field-input" data-test="cf-storage">
            <option value="">不指定</option>
            <option value="core">core（经核心代理）</option>
            <option value="shared">shared（共享库）</option>
            <option value="dedicated">dedicated（核心代供）</option>
            <option value="external">external（模块自备）</option>
          </select>
        </label>
        <p class="add-dialog-hint">
          凭证只用于本次部署，不写入实例数据，也不进日志（决策 #165）。带 Durable Object / 资产 / 迁移的模块
          仍走安装器装配期路径。
        </p>
      </div>

      <p v-if="errorText" class="add-dialog-alert" role="alert" data-test="add-module-alert">{{ errorText }}</p>
      <p v-else-if="connectStatus === 'online'" class="add-dialog-status" role="status" data-test="add-module-status">
        模块已连上来（隧道在线）
      </p>

      <footer class="add-dialog-actions">
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
    </section>
  </div>
</template>

<style scoped>
.add-dialog-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-scrim);
}
.add-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-4);
  width: min(560px, 100%);
  max-height: calc(100vh - var(--unself-space-8));
  overflow: auto;
  padding: var(--unself-space-6);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-surface);
  box-shadow: var(--unself-shadow-pop);
}
.add-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
}
.add-dialog-title {
  margin: 0;
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
}
.add-dialog-close {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-base);
}
.add-dialog-tabs {
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
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
}
.add-field {
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
.add-dialog-hint {
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-text-secondary);
}
.add-dialog-env {
  margin: 0;
  padding: var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  font-size: var(--unself-font-size-sm);
  white-space: pre-wrap;
  word-break: break-all;
}
.add-dialog-alert {
  margin: 0;
  color: var(--unself-color-danger);
  font-size: var(--unself-font-size-sm);
}
.add-dialog-status {
  margin: 0;
  color: var(--unself-color-text-secondary);
  font-size: var(--unself-font-size-sm);
}
.add-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--unself-space-3);
}
</style>
