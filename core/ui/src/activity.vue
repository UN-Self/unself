<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ActivityGroup } from './activity-types'
/**
 * 公共基元：智能体/装配活动摘要（§6.5 组件查找序① beUI agents「Agent Activity」）：
 * 事件按步骤分组折叠、默认收起只显摘要计数、完成/失败标记、逐条流式追加。
 * 分组/去重语义由调用方数据侧完成（基元只渲染给定组——数据不因渲染方式漂移）。
 * 动效：新组入场 lift+fade（duration-fast + ease-out）、marker 状态切换；reduced-motion 退化。
 */
import { computed } from 'vue'
import { CheckCircle2, CircleDashed, TriangleAlert } from 'lucide-vue-next'

const markerOf = (state: string) => (state === 'complete' ? CheckCircle2 : state === 'failed' ? TriangleAlert : CircleDashed)

const props = defineProps<{
  groups: ActivityGroup[]
  /** 摘要文案（折叠时 summary 右侧计数，如「3 个步骤」）。 */
  summary: string
}>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const open = defineModel<boolean>('open', { default: false })

const failedCount = computed(() => props.groups.filter((g) => g.state === 'failed').length)
</script>

<template>
  <details class="u-activity" :open="open" @toggle="emit('update:open', ($event.target as HTMLDetailsElement).open)">
    <summary class="u-activity-summary">
      <span class="u-activity-title">装配活动</span>
      <span class="u-activity-count" :class="{ 'u-activity-count-failed': failedCount > 0 }">{{ summary }}</span>
    </summary>
    <ol class="u-activity-list" aria-live="polite">
      <li
        v-for="group in groups"
        :key="group.step"
        class="u-activity-item"
        :class="`u-activity-${group.state}`"
      >
        <details class="u-activity-group" :open="group.state === 'failed'">
          <summary class="u-activity-group-summary">
            <span class="u-activity-marker" aria-hidden="true">
              <component :is="markerOf(group.state)" :size="14" />
            </span>
            <span class="u-activity-group-title">{{ group.title }}</span>
          </summary>
          <div class="u-activity-lines">
            <div v-for="line in group.lines" :key="line.i" class="u-activity-line">
              <span class="u-activity-text">{{ line.text }}</span>
            </div>
          </div>
        </details>
      </li>
    </ol>
  </details>
</template>

<style scoped>
.u-activity {
  border: 1px solid var(--unself-color-border);
  border-radius: var(--unself-radius-md);
  padding: var(--unself-space-2) var(--unself-space-3);
  margin: var(--unself-space-3) 0;
  background: var(--unself-color-surface);
}
.u-activity-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  color: var(--unself-color-info);
  font-size: var(--unself-font-size-sm);
  list-style: none;
}
.u-activity-summary::-webkit-details-marker {
  display: none;
}
.u-activity-count {
  color: var(--unself-color-text-tertiary);
}
.u-activity-count-failed {
  color: var(--unself-color-danger);
}
.u-activity-list {
  list-style: none;
  padding: var(--unself-space-2) 0 0;
  margin: 0;
}
.u-activity-item {
  padding: var(--unself-space-2) 0;
  border-top: 1px solid var(--unself-color-border);
  animation: u-activity-in var(--unself-duration-fast) var(--unself-ease-out);
}
.u-activity-group-summary {
  display: grid;
  grid-template-columns: var(--unself-space-5) minmax(0, 1fr);
  gap: var(--unself-space-2);
  align-items: start;
  cursor: pointer;
  list-style: none;
}
.u-activity-group-summary::-webkit-details-marker {
  display: none;
}
.u-activity-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--unself-space-5);
  color: var(--unself-color-text-tertiary);
}
.u-activity-complete .u-activity-marker {
  color: var(--unself-color-success);
}
.u-activity-failed .u-activity-marker {
  color: var(--unself-color-danger);
}
.u-activity-group-title {
  font-family: ui-monospace, monospace;
  font-size: var(--unself-font-size-sm);
  overflow-wrap: anywhere;
}
.u-activity-lines {
  margin: var(--unself-space-2) 0 0;
  color: var(--unself-color-text-secondary);
}
.u-activity-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--unself-space-2);
  padding: var(--unself-space-1) 0;
}
.u-activity-text {
  font-family: ui-monospace, monospace;
  font-size: var(--unself-font-size-sm);
  overflow-wrap: anywhere;
}
@keyframes u-activity-in {
  from {
    opacity: 0;
    transform: translateY(var(--unself-motion-lift-y));
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .u-activity-item {
    animation: none;
  }
}
</style>
