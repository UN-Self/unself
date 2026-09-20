<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue'

import { renderMarkdown } from '../lib/markdown'

/**
 * 消息正文渲染（#218 C 路）：renderMarkdown 消毒后的 HTML 才进 v-html；
 * 裸 @username 高亮（data-mention span，primary-soft 底）。
 */
const props = defineProps<{
  /** 原始消息 Markdown 文本。 */
  content: string
}>()

const html = computed(() => renderMarkdown(props.content))
</script>

<template>
  <!-- 安全：唯一来源 renderMarkdown（markdown-it html:false + DOMPurify 白名单），见 lib/markdown.ts -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="message-markdown" data-test="message-markdown" v-html="html" />
</template>

<style scoped>
.message-markdown {
  /* 行高无契约令牌——用字号倍率（无单位）而非裸 px；不在 var 白名单引未定义令牌 */
  line-height: 1.5;
  word-break: break-word;
  white-space: normal;
}
.message-markdown :deep(a) {
  color: var(--unself-color-primary);
  text-decoration: underline;
}
.message-markdown :deep([data-mention]) {
  background: var(--unself-color-primary-soft);
  color: var(--unself-color-primary);
  border-radius: var(--unself-radius-sm);
  padding: 0 var(--unself-space-1);
}

/* 渲染间距（markdown 块级元素默认 margin 压平，避免气泡内双重间距） */
.message-markdown :deep(p) {
  margin: 0;
}
.message-markdown :deep(p + p),
.message-markdown :deep(ul),
.message-markdown :deep(ol),
.message-markdown :deep(blockquote) {
  margin-top: var(--unself-space-2);
}
</style>
