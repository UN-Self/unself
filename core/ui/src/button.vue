<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'

/**
 * 按钮基元：primary / outline / ghost 三变体 + sm/md/lg 尺寸。
 * 动效参数（§6.5 查找序）：beUI button-base 的 press-scale/hover-lift 语义
 * 在无 motion 库下以 transition + active:scale 等价移植：
 * - 按下 = scale(var(--unself-motion-press-scale))（beUI SPRING_PRESS 语义）
 * - 悬浮 = 主按钮 scale(1.02) 微浮（beUI hover，阴影在按钮上是脏区，故用 transform）
 * 时长走 --duration-fast、缓动 --ease-out（#307 基础反馈层）。
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
  gap: var(--unself-space-2);
  border-radius: var(--unself-radius-md);
  font-size: var(--unself-font-size-base);
  font-weight: 500;
  line-height: 1;
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
  transition:
    background-color var(--unself-duration-fast) var(--unself-ease-out),
    border-color var(--unself-duration-fast) var(--unself-ease-out),
    color var(--unself-duration-fast) var(--unself-ease-out),
    transform var(--unself-duration-fast) var(--unself-ease-out);
}
.u-btn:active:not(:disabled) {
  /* #307 ①基础反馈层：beUI SPRING_PRESS——数值出自契约令牌，禁魔法数 */
  transform: scale(var(--unself-motion-press-scale));
}
.u-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.u-btn:focus-visible {
  outline: var(--unself-focus-ring);
  outline-offset: 2px;
}

.u-btn-primary {
  background: var(--unself-color-primary);
  color: var(--unself-color-bg);
}
.u-btn-primary:hover:not(:disabled) {
  background: var(--unself-color-primary-hover);
  /* #307 ①基础反馈层：beUI hover 微浮（1.02）——只 transform，不叠阴影 */
  transform: scale(1.02);
}

.u-btn-outline {
  background: var(--unself-color-bg);
  color: var(--unself-color-text);
  border-color: var(--unself-color-border);
}
.u-btn-outline:hover:not(:disabled) {
  background: var(--unself-color-surface);
}

.u-btn-ghost {
  background: transparent;
  color: var(--unself-color-text-secondary);
}
.u-btn-ghost:hover:not(:disabled) {
  background: var(--unself-color-surface);
  color: var(--unself-color-text);
}

.u-btn-sm {
  height: 32px;
  padding: 0 var(--unself-space-3);
}
.u-btn-md {
  height: 40px;
  padding: 0 var(--unself-space-4);
}
.u-btn-lg {
  height: 48px;
  padding: 0 var(--unself-space-6);
  font-size: var(--unself-font-size-lg);
}

.u-btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: var(--unself-radius-full);
  animation: u-spin var(--unself-duration-spin) linear infinite;
}
@keyframes u-spin {
  to {
    transform: rotate(360deg);
  }
}
/* 降低动效偏好：旋转退化为静态指示（按钮上仍有 loading 文案/禁用态，不丢信息）；
   按压/悬浮缩放归零——状态语义（active/hover 底色变化）仍在，不丢信息（#307） */
@media (prefers-reduced-motion: reduce) {
  .u-btn-spinner {
    animation: none;
  }
  .u-btn:active:not(:disabled),
  .u-btn-primary:hover:not(:disabled) {
    transform: none;
  }
}
</style>
