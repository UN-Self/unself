<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'

/**
 * 按钮基元：primary / outline / ghost 三变体 + sm/md/lg 尺寸。
 * 动效参数（§6.5 查找序）：beUI button-base 的 press-scale/hover-lift 语义
 * 在无 motion 库下以 transition + active:scale 等价移植，时长取 tokens
 * --duration-fast，缓动 --ease-out。
 */
export interface ButtonProps {
  variant?: 'primary' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  type?: 'button' | 'submit'
  disabled?: boolean
  loading?: boolean
}

const props = withDefaults(defineProps<ButtonProps>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
  disabled: false,
  loading: false,
})

const variantClass = computed(() => {
  switch (props.variant) {
    case 'outline':
      return 'u-btn-outline'
    case 'ghost':
      return 'u-btn-ghost'
    default:
      return 'u-btn-primary'
  }
})

const sizeClass = computed(() => {
  switch (props.size) {
    case 'sm':
      return 'u-btn-sm'
    case 'lg':
      return 'u-btn-lg'
    default:
      return 'u-btn-md'
  }
})
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="u-btn"
    :class="[variantClass, sizeClass]"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="u-btn-spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.u-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  font-weight: 500;
  line-height: 1;
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.u-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.u-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.u-btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.u-btn-primary {
  background: var(--color-primary);
  color: var(--color-bg);
}
.u-btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.u-btn-outline {
  background: var(--color-bg);
  color: var(--color-text);
  border-color: var(--color-border);
}
.u-btn-outline:hover:not(:disabled) {
  background: var(--color-surface);
}

.u-btn-ghost {
  background: transparent;
  color: var(--color-text-secondary);
}
.u-btn-ghost:hover:not(:disabled) {
  background: var(--color-surface);
  color: var(--color-text);
}

.u-btn-sm {
  height: 32px;
  padding: 0 var(--space-3);
}
.u-btn-md {
  height: 40px;
  padding: 0 var(--space-4);
}
.u-btn-lg {
  height: 48px;
  padding: 0 var(--space-6);
  font-size: var(--font-size-lg);
}

.u-btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--radius-full);
  animation: u-spin 0.8s linear infinite;
}
@keyframes u-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
