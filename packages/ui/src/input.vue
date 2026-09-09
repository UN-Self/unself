<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'

/**
 * 输入框基元：label + 可选错误行（稳定占位不跳动）+ 左侧图标插槽。
 * 移植 beUI input 的「稳定错误行 / 错误抖动」语义（§6.5 查找序）：
 * 抖动以 CSS keyframes 等价实现（时长 0.45s 照抄 beUI），错误清除即复位。
 */
export interface InputProps {
  modelValue?: string
  label?: string
  type?: 'text' | 'password' | 'url' | 'email'
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

// #83：useId 替代 Math.random——SSR/客户端 id 稳定、可读无随机（表单契约）
const inputId = useId()

// 错误抖动（beUI 语义）：错误从无到有的瞬间置 true 触发一次 u-shake，
// @animationend 复位；错误清除立即复位，保证下次错误仍能重新触发。
// （旧实现 shaking 恒为 false——无任何赋值时机，抖动画死变量的残留。）
const shaking = ref(false)

const hasError = computed(() => Boolean(props.error))
const errorMessage = computed(() => (typeof props.error === 'string' ? props.error : null))

watch(hasError, (now, was) => {
  if (now && !was) shaking.value = true
  else if (!now) shaking.value = false
})

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
  gap: var(--unself-space-1);
}
.u-field-label {
  padding: 0 var(--unself-space-1);
  font-size: var(--unself-font-size-sm);
  font-weight: 500;
  color: var(--unself-color-text);
}
.u-field-required {
  margin-left: 2px;
  color: var(--unself-color-danger);
}

.u-input {
  height: 40px;
  padding: 0 var(--unself-space-3);
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
  font-size: var(--unself-font-size-base);
  transition:
    border-color var(--unself-duration-fast) var(--unself-ease-out),
    box-shadow var(--unself-duration-fast) var(--unself-ease-out);
}
.u-input::placeholder {
  color: var(--unself-color-text-tertiary);
}
.u-input:focus {
  outline: none;
  border-color: var(--unself-color-primary);
  box-shadow: 0 0 0 3px var(--unself-color-primary-soft);
}
.u-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.u-input-error {
  border-color: var(--unself-color-danger);
}
.u-input-error:focus {
  border-color: var(--unself-color-danger);
  box-shadow: 0 0 0 3px var(--unself-color-danger-soft);
}

/* beUI input 的错误抖动：0.45s，位移序列照抄 */
.u-input-shake {
  animation: u-shake 0.45s var(--unself-ease-out);
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
  padding: 0 var(--unself-space-1);
  font-size: var(--unself-font-size-xs);
  color: var(--unself-color-danger);
}
</style>
