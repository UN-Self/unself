<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 聊天模块根视图（占位骨架，issue 218 T1）：
 * 布局与数据接线由 T2/T3/T4 worker 填充（见任务书 /tmp/tasks/task-218.md）。
 */
</script>

<template>
  <div class="chat-root">
    <p class="chat-root-hint">chat frontend scaffold (issue 218)</p>
  </div>
</template>

<style scoped>
.chat-root {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat-root-hint {
  color: var(--unself-color-text-tertiary);
}
</style>
