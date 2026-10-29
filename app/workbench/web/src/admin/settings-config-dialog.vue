<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 设置编辑弹窗（决策 #100）：OIDC / 邮箱管理 / 通知发信共用的水舱壳。
 * - 水位由 testing / okDetail 派生（testing → testing，成功 → full，其余 → rest），纯装饰、恒 aria-hidden；
 *   页面持有测试态，本组件不自己发请求。
 * - 主动作一颗按钮：非成功态「测试连接」（emit test），成功态「保存配置」（emit save）；
 *   「跳过测试，直接保存」只在非成功且非测试在途时出现（emit save）。
 * - 字段由默认 slot 注入；Esc 关闭、打开焦点入内、关闭焦点归还触发元素走 use-layer-focus。
 * - errorText 优先于成功态 status 行显示（失败 alert 压住 status）。
 * 行为对照见 admin-pages.test.ts「SettingsPage 水舱动线 / 弹窗重开 / 弹层可达性」各节。
 */
import { computed, ref } from 'vue'

import { UButton } from '@unself/ui'

import WaveFill from '../components/wave-fill.vue'
import { useLayerFocus } from '../lib/use-layer-focus'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** data-test 后缀：oidc | stalwart | smtp。 */
    domain: 'oidc' | 'stalwart' | 'smtp'
    title: string
    /** 顶部提示条（enable-pending：「补全并保存后自动启用」）；空 = 不显示。 */
    hint?: string
    /** 测试在途（页面持有）：水位 testing + 按钮 loading。 */
    testing?: boolean
    /** 保存在途：按钮 loading（成功态下这颗按钮就是保存）。 */
    saving?: boolean
    /** 最近一次测试成功的人话；非 null = 成功态（水位 full、按钮变「保存配置」）。 */
    okDetail?: string | null
    /** 失败 / 保存错误文案；非 null 显示 role=alert。水位不随错误变：测试失败回 rest，成功后保存失败仍是 full。 */
    errorText?: string | null
  }>(),
  {
    hint: '',
    testing: false,
    saving: false,
    okDetail: null,
    errorText: null,
  },
)

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** 非成功态点主动作：测试连接。 */
  test: []
  /** 成功态点主动作，以及「跳过测试，直接保存」。 */
  save: []
}>()

/** testing 优先于成功。成功 = full，其余 = rest。 */
const level = computed(() => (props.testing ? 'testing' : props.okDetail !== null ? 'full' : 'rest'))
/** 成功态：主动作按钮变为「保存配置」。 */
const isSuccess = computed(() => !props.testing && props.okDetail !== null)

const layerEl = ref<HTMLElement | null>(null)
// 可写 computed（ConfirmDialog 同款）：useLayerFocus 的 Esc 关闭走 open.value = false，
// 必须能写回 v-model（只读 computed 会让 Esc 静默失效）
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})
const { onKeydown } = useLayerFocus(open, () => layerEl.value)

function close(): void {
  emit('update:modelValue', false)
}

/** 成功态保存，其余状态测试。保存在途仍走保存，不退回测试。 */
function onAction(): void {
  if (isSuccess.value) emit('save')
  else emit('test')
}
</script>

<template>
  <div
    v-if="modelValue"
    class="settings-dialog-scrim"
    @click.self="close"
    @keydown="onKeydown"
  >
    <section
      ref="layerEl"
      class="settings-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      :data-test="`settings-dialog-${domain}`"
      @click.stop
    >
      <header class="settings-dialog-head">
        <h2 class="settings-dialog-title">{{ title }}</h2>
        <button
          type="button"
          class="settings-dialog-close"
          aria-label="关闭"
          data-test="settings-dialog-close"
          @click="close"
        >
          ✕
        </button>
      </header>

      <p v-if="hint" class="settings-dialog-hint" data-test="settings-dialog-hint">{{ hint }}</p>

      <!-- 字段区（水位之上：内容层 z-index 压在装饰层之上） -->
      <div class="settings-dialog-fields">
        <slot />
      </div>

      <p v-if="errorText" class="settings-dialog-alert" role="alert" data-test="settings-dialog-alert">
        {{ errorText }}
      </p>
      <p v-else-if="isSuccess" class="settings-dialog-status" role="status" data-test="settings-dialog-status">
        {{ okDetail }}
      </p>

      <footer class="settings-dialog-actions">
        <UButton
          :variant="isSuccess ? 'primary' : 'outline'"
          :loading="testing || saving"
          class="settings-dialog-action-btn"
          :data-test="`settings-action-${domain}`"
          @click="onAction"
        >
          {{ isSuccess ? '保存配置' : '测试连接' }}
        </UButton>
        <button
          v-if="!isSuccess && !testing"
          type="button"
          class="settings-dialog-skip"
          :data-test="`settings-skip-${domain}`"
          :disabled="saving"
          @click="emit('save')"
        >
          跳过测试，直接保存
        </button>
      </footer>

      <!-- 装饰水面：内容层 z-index 压在其上 -->
      <WaveFill :level="level" />
    </section>
  </div>
</template>

<style scoped>
.settings-dialog-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-scrim);
}
.settings-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: var(--unself-space-4);
  width: min(520px, 100%);
  min-height: min(520px, calc(100vh - var(--unself-space-8)));
  max-height: calc(100vh - var(--unself-space-8));
  overflow: hidden;
  padding: var(--unself-space-6);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-surface);
  box-shadow: var(--unself-shadow-pop);
  animation: settings-dialog-in var(--unself-duration-normal) var(--unself-ease-out);
}
.settings-dialog:focus {
  outline: none;
}
@keyframes settings-dialog-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
/* 水舱装饰层 WaveFill 绝对铺满整个弹窗（inset: 0）；内容块必须显式抬层，否则满灌时被水盖住。
 * 下方所有内容块都与标题共用同一套“position: relative + z-index: 1”。 */
.settings-dialog-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--unself-space-3);
}
.settings-dialog-title {
  margin: 0;
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
}
.settings-dialog-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--unself-radius-md);
  background: transparent;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-base);
  cursor: pointer;
}
.settings-dialog-close:hover {
  background: var(--unself-color-surface-active);
  color: var(--unself-color-text);
}
.settings-dialog-close:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}
.settings-dialog-hint {
  position: relative;
  z-index: 1;
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font-size: var(--unself-font-size-sm);
}
.settings-dialog-fields {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--unself-space-4);
  align-items: start;
}
.settings-dialog-alert {
  position: relative;
  z-index: 1;
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-danger-soft);
  color: var(--unself-color-danger);
  font-size: var(--unself-font-size-sm);
}
.settings-dialog-status {
  position: relative;
  z-index: 1;
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-success);
  font-weight: 500;
}
.settings-dialog-actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-2);
  margin-top: auto;
  padding-bottom: var(--unself-space-5);
}
.settings-dialog-action-btn {
  width: 100%;
}
.settings-dialog-skip {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-sm);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.settings-dialog-skip:hover:not(:disabled) {
  color: var(--unself-color-text-secondary);
}
.settings-dialog-skip:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.settings-dialog-skip:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .settings-dialog-fields {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-dialog {
    animation: none;
  }
}
</style>
