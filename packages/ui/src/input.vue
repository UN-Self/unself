<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * 输入框基元：label + 可选错误行（稳定占位不跳动）+ 左侧图标插槽。
 * 移植 beUI input 的「稳定错误行 / 错误抖动」语义（§6.5 查找序）：
 * 抖动以 CSS keyframes 等价实现（时长 0.45s 照抄 beUI），错误清除即复位。
 */
export interface InputProps {
  modelValue?: string
  label?: string
  type?: 'text' | 'password' | 'url'
  placeholder?: string
  required?: boolean
  autocomplete?: string
  disabled?: boolean
  /** 字符串错误信息或 true（仅红框）；错误出现触发抖动。 */
  error?: string | boolean
  /** 预留一行错误位，校验时不挤动布局。 */
  reserveErrorLine?: boolean
  name?: string
}

const props = withDefaults(defineProps<InputProps>(), {
  modelValue: '',
  label: undefined,
  type: 'text',
  placeholder: undefined,
  required: false,
  autocomplete: undefined,
  disabled: false,
  error: false,
  reserveErrorLine: false,
  name: undefined,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const inputId = `u-input-${Math.random().toString(36).slice(2, 9)}`
const shaking = ref(false)
let shakeTimer: ReturnType<typeof setTimeout> | undefined

const hasError = computed(() => Boolean(props.error))
const errorMessage = computed(() => (typeof props.error === 'string' ? props.error : null))

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="u-field">
    <label v-if="label" :for="inputId" class="u-field-label">
      {{ label }}<span v-if="required" class="u-field-required" aria-hidden="true">*</span>
    </label>
    <input
      :id="inputId"
      class="u-input"
      :class="{ 'u-input-error': hasError, 'u-input-shake': shaking }"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :required="required"
      :autocomplete="autocomplete"
      :disabled="disabled"
      :name="name"
      :aria-invalid="hasError || undefined"
      :aria-describedby="errorMessage ? `${inputId}-error` : undefined"
      @input="onInput"
      @animationend="shaking = false"
    >
    <div :class="reserveErrorLine ? 'u-field-error-row-reserved' : 'u-field-error-row'">
      <p v-if="errorMessage" :id="`${inputId}-error`" role="alert" class="u-field-error">
        {{ errorMessage }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.u-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.u-field-label {
  padding: 0 var(--space-1);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
}
.u-field-required {
  margin-left: 2px;
  color: var(--color-danger);
}

.u-input {
  height: 40px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-size-base);
  transition:
    border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.u-input::placeholder {
  color: var(--color-text-tertiary);
}
.u-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.u-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.u-input-error {
  border-color: var(--color-danger);
}
.u-input-error:focus {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 3px var(--color-danger-soft);
}

/* beUI input 的错误抖动：0.45s，位移序列照抄 */
.u-input-shake {
  animation: u-shake 0.45s var(--ease-out);
}
@keyframes u-shake {
  0% { transform: translateX(0); }
  16% { transform: translateX(-6px); }
  33% { transform: translateX(6px); }
  50% { transform: translateX(-4px); }
  66% { transform: translateX(4px); }
  83% { transform: translateX(-2px); }
  100% { transform: translateX(0); }
}

.u-field-error-row,
.u-field-error-row-reserved {
  min-height: 0;
}
.u-field-error-row-reserved {
  min-height: 16px;
}
.u-field-error {
  padding: 0 var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}
</style>
