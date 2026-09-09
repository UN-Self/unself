<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleAlert, ChevronDown } from 'lucide-vue-next'
import { computed, ref } from 'vue'

/**
 * 错误卡基元（§6.5 异常规范）：成员只见人话 + request id；
 * 可选「技术详情」折叠区（管理员态由调用方传入详情后展示开关）。
 */
export interface ErrorCardProps {
  /** 人话标题（成员视角）。 */
  title: string
  /** 人话说明（成员视角）。 */
  message?: string
  /** request id（服务端返回，透传展示）。 */
  requestId?: string
  /** 技术详情（堆栈/响应体）；传入后显示可折叠区。 */
  detail?: string
  /** 重试按钮文案；不传则不显示重试。 */
  retryLabel?: string
}

const props = withDefaults(defineProps<ErrorCardProps>(), {
  message: undefined,
  requestId: undefined,
  detail: undefined,
  retryLabel: undefined,
})

const emit = defineEmits<{ retry: [] }>()

const expanded = ref(false)
const hasDetail = computed(() => Boolean(props.detail))
</script>

<template>
  <div class="u-error" role="alert">
    <div class="u-error-head">
      <CircleAlert class="u-error-icon" :size="20" aria-hidden="true" />
      <div class="u-error-body">
        <p class="u-error-title">{{ title }}</p>
        <p v-if="message" class="u-error-message">{{ message }}</p>
        <p v-if="requestId" class="u-error-request">请求编号：{{ requestId }}</p>
      </div>
    </div>
    <div class="u-error-actions">
      <button v-if="retryLabel" type="button" class="u-error-retry" @click="emit('retry')">
        {{ retryLabel }}
      </button>
      <button
        v-if="hasDetail"
        type="button"
        class="u-error-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        技术详情
        <ChevronDown class="u-error-chevron" :class="{ 'u-error-chevron-open': expanded }" :size="14" aria-hidden="true" />
      </button>
    </div>
    <pre v-if="hasDetail && expanded" class="u-error-detail">{{ detail }}</pre>
  </div>
</template>

<style scoped>
.u-error {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-lg);
}
.u-error-head {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}
.u-error-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--color-danger);
}
.u-error-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.u-error-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
}
.u-error-message {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
.u-error-request {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}
.u-error-actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}
.u-error-retry,
.u-error-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out);
}
.u-error-retry:hover,
.u-error-toggle:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}
.u-error-chevron {
  transition: transform var(--duration-fast) var(--ease-out);
}
.u-error-chevron-open {
  transform: rotate(180deg);
}
.u-error-detail {
  margin: 0;
  padding: var(--space-3);
  max-height: 200px;
  overflow: auto;
  background: var(--color-surface);
  border-radius: var(--radius-md);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
