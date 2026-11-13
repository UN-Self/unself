<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 设置编辑弹窗（决策 #100）：OIDC / 邮箱管理 / 通知发信共用。
 * 壳（遮罩/标题栏/✕/焦点三契约/装饰水面/入场动画）已收进 components/aqua-dialog.vue（#349 消融：外壳一次编写）。
 * 本组件只留领域动线：
 * - 水位由 testing / okDetail 派生（testing → testing，成功 → full，其余 → rest）；页面持有测试态，本组件不发请求。
 * - 主动作一颗按钮：非成功态「测试连接」（emit test），成功态「保存配置」（emit save）；
 *   「跳过测试，直接保存」只在非成功且非测试在途时出现（emit save）。
 * - 字段由默认 slot 注入（挂 aqua-dialog-fields 抬层压水面）。
 * - errorText 优先于成功态 status 行显示（失败 alert 压住 status）。
 * 行为对照见 admin-pages.test.ts「SettingsPage 水舱动线 / 弹窗重开 / 弹层可达性」各节。
 */
import { computed } from 'vue'

import { UButton } from '@unself/ui'

import AquaDialog from '../components/aqua-dialog.vue'

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
  /** 成功态主动作，以及「跳过测试，直接保存」。 */
  save: []
}>()

/** testing 优先于成功。成功 = full，其余 = rest。 */
const level = computed(() => (props.testing ? 'testing' : props.okDetail !== null ? 'full' : 'rest'))
/** 成功态：主动作按钮变为「保存配置」。 */
const isSuccess = computed(() => !props.testing && props.okDetail !== null)

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
  <AquaDialog
    :model-value="modelValue"
    :title="title"
    :name="`settings-dialog-${domain}`"
    close-name="settings-dialog-close"
    :level="level"
    @update:model-value="close"
  >
    <p v-if="hint" class="aqua-dialog-hint" data-test="settings-dialog-hint">{{ hint }}</p>

    <!-- 字段区（水位之上：内容层 z-index 压在装饰层之上） -->
    <div class="aqua-dialog-fields">
      <slot />
    </div>

    <p v-if="errorText" class="aqua-dialog-alert" role="alert" data-test="settings-dialog-alert">
      {{ errorText }}
    </p>
    <p v-else-if="isSuccess" class="aqua-dialog-status" role="status" data-test="settings-dialog-status">
      {{ okDetail }}
    </p>

    <footer class="aqua-dialog-actions">
      <UButton
        :variant="isSuccess ? 'primary' : 'outline'"
        :loading="testing || saving"
        class="aqua-dialog-action-btn"
        :data-test="`settings-action-${domain}`"
        @click="onAction"
      >
        {{ isSuccess ? '保存配置' : '测试连接' }}
      </UButton>
      <button
        v-if="!isSuccess && !testing"
        type="button"
        class="aqua-dialog-skip"
        :data-test="`settings-skip-${domain}`"
        :disabled="saving"
        @click="emit('save')"
      >
        跳过测试，直接保存
      </button>
    </footer>
  </AquaDialog>
</template>

<style scoped>
/* 壳归 aqua-dialog.vue；这里只留内容块抬层与领域块样式（全 tokens）。 */
.aqua-dialog-hint {
  position: relative;
  z-index: 1;
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  font-size: var(--unself-font-size-sm);
}
.aqua-dialog-fields {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--unself-space-4);
  align-items: start;
}
.aqua-dialog-alert {
  position: relative;
  z-index: 1;
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-danger-soft);
  color: var(--unself-color-danger);
  font-size: var(--unself-font-size-sm);
}
.aqua-dialog-status {
  position: relative;
  z-index: 1;
  margin: 0;
  font-size: var(--unself-font-size-sm);
  color: var(--unself-color-success);
  font-weight: 500;
}
.aqua-dialog-actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--unself-space-2);
  margin-top: auto;
  padding-bottom: var(--unself-space-5);
}
.aqua-dialog-action-btn {
  width: 100%;
}
.aqua-dialog-skip {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--unself-color-text-tertiary);
  font-size: var(--unself-font-size-sm);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.aqua-dialog-skip:hover:not(:disabled) {
  color: var(--unself-color-text-secondary);
}
.aqua-dialog-skip:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.aqua-dialog-skip:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .aqua-dialog-fields {
    grid-template-columns: 1fr;
  }
}
</style>
