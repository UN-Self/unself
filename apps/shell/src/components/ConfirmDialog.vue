<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 站内确认弹层（#192 F6 去原生弹窗）：
 * - 承接「拒绝申请 / 停用成员」二次确认与「重置密码」带输入确认（前置校验）
 * - F5 契约同款：Esc 关闭 + 打开焦点入内 + 关闭焦点回触发元素（use-layer-focus）
 * - 语义：danger 动作用 danger 色主按钮；取消永远在场（键盘可达）
 * - 一次性链接口径不适用（本组件不显示机密；重置密码输入框 type=password 只写不读）
 */
import { computed, ref, watch } from 'vue'

import { UButton } from '@unself/ui'

import { useLayerFocus } from '../lib/use-layer-focus'

/**
 * props.modelValue = 弹层开合（v-model）；
 * props.kind：confirm（普通确认）/ danger（危险确认，主按钮 danger）
 * props.withPassword：重置密码模式（带新密码输入 + 长度/一致性前置校验）
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    /** 正文（确认语义人话；withPassword 模式下与输入框同显）。 */
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    kind?: 'confirm' | 'danger'
    withPassword?: boolean
  }>(),
  {
    message: '',
    confirmLabel: '确认',
    cancelLabel: '取消',
    kind: 'confirm',
    withPassword: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** 确认（withPassword 模式带密码值；否则空串）。 */
  confirm: [password: string]
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const password = ref('')
const passwordConfirm = ref('')
const touched = ref(false)
const layerEl = ref<HTMLElement | null>(null)

const { onKeydown } = useLayerFocus(open, () => layerEl.value)

/** 打开即重置输入与校验态（上次会话残留不进新会话）。 */
watch(
  () => props.modelValue,
  (now) => {
    if (now) {
      password.value = ''
      passwordConfirm.value = ''
      touched.value = false
    }
  },
)

/** 前置校验（#192 F6：长度 ≥8 + 两次一致；只校长度与一致性，强度熵不越权预判）。 */
const passwordError = computed(() => {
  if (!props.withPassword || !touched.value) return ''
  if (password.value.length < 8) return '密码长度至少 8 位'
  if (passwordConfirm.value !== password.value) return '两次输入的密码不一致'
  return ''
})

/** 校验未通过时确认按钮禁用（保留按钮占位，视觉层级不变）。 */
const canConfirm = computed(() => {
  if (!props.withPassword) return true
  return password.value.length >= 8 && passwordConfirm.value === password.value
})

function onCancel(): void {
  open.value = false
}

function onConfirm(): void {
  if (!canConfirm.value) {
    touched.value = true
    return
  }
  emit('confirm', props.withPassword ? password.value : '')
  open.value = false
}
</script>

<template>
  <div
    v-if="modelValue"
    class="u-confirm-scrim"
    @click.self="onCancel"
    @keydown="onKeydown"
  >
    <section
      ref="layerEl"
      class="u-confirm"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      @click.stop
    >
      <h2 class="u-confirm-title">{{ title }}</h2>
      <p v-if="message" class="u-confirm-message">{{ message }}</p>

      <template v-if="withPassword">
        <label class="u-confirm-label" for="u-confirm-password">新密码（至少 8 位）</label>
        <input
          id="u-confirm-password"
          v-model="password"
          class="u-confirm-input"
          type="password"
          autocomplete="new-password"
          @input="touched = true"
        >
        <label class="u-confirm-label" for="u-confirm-password-2">再输入一次</label>
        <input
          id="u-confirm-password-2"
          v-model="passwordConfirm"
          class="u-confirm-input"
          type="password"
          autocomplete="new-password"
          @input="touched = true"
        >
        <p v-if="passwordError" class="u-confirm-error" role="alert">{{ passwordError }}</p>
      </template>

      <div class="u-confirm-actions">
        <UButton variant="outline" @click="onCancel">{{ cancelLabel }}</UButton>
        <UButton
          :variant="kind === 'danger' ? 'outline' : 'primary'"
          :class="kind === 'danger' ? 'u-confirm-danger' : undefined"
          :disabled="withPassword && !canConfirm"
          @click="onConfirm"
        >
          {{ confirmLabel }}
        </UButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.u-confirm-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--unself-space-4);
  background: var(--unself-color-scrim);
}
.u-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--unself-space-3);
  width: min(440px, 100%);
  padding: var(--unself-space-6);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-lg);
  background: var(--unself-color-bg);
  box-shadow: var(--unself-shadow-pop);
}
.u-confirm:focus {
  outline: none;
}
.u-confirm-title {
  margin: 0;
  font-size: var(--unself-font-size-lg);
  font-weight: 600;
  color: var(--unself-color-text);
}
.u-confirm-message {
  margin: 0;
  font-size: var(--unself-font-size-base);
  color: var(--unself-color-text-secondary);
}
.u-confirm-label {
  font-size: var(--unself-font-size-sm);
  font-weight: 500;
  color: var(--unself-color-text);
}
.u-confirm-input {
  height: 40px;
  padding: 0 var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-base);
}
.u-confirm-input:focus {
  outline: none;
  border-color: var(--unself-color-primary);
  box-shadow: 0 0 0 3px var(--unself-color-primary-soft);
}
.u-confirm-error {
  margin: 0;
  padding: var(--unself-space-2) var(--unself-space-3);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-danger-soft);
  color: var(--unself-color-danger);
  font-size: var(--unself-font-size-sm);
}
.u-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--unself-space-2);
  margin-top: var(--unself-space-2);
}
/* 危险确认：danger 色文字（UButton 无 danger 变体，叠 tokens 一层，不改 packages/ui） */
.u-confirm-danger {
  color: var(--unself-color-danger);
  border-color: var(--unself-color-danger);
}
.u-confirm-danger:hover:not(:disabled) {
  background: var(--unself-color-danger-soft);
}
</style>
