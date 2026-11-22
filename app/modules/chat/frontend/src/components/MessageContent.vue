<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Message } from '../lib/types'
import { splitMentionSegments } from '../lib/mention-text'
import MessageAttachment from './MessageAttachment.vue'
const props = defineProps<{ message: Message }>()
const firstAttachment = ref<InstanceType<typeof MessageAttachment> | null>(null)
defineExpose({ preview: () => firstAttachment.value?.preview() })

/**
 * #347 气泡内 @ 高亮：按 message.mentions 的 username 切分文本，命中片段蓝色高亮
 * （非链接、不可点，不引入跳转/权限语义）；mentions 空或无命中即纯文本。
 * 只按 username 匹配（#347 定案：手打 displayName 不算提及，不高亮）；token 与显示分离：
 * 文本里存的是 @username（core:xxx 稳定 token，改名不失配），显示统一换成 @displayName
 * ——mentions 是读时 JOIN，改名后旧消息也显示新名。
 */
const mentionLabels = computed(() => {
  const labels = new Map<string, string>()
  for (const mention of props.message.mentions ?? []) {
    labels.set(mention.username.toLowerCase(), mention.displayName)
  }
  if (props.message.mentionAll) labels.set('所有人', '所有人')
  return labels
})

function segmentsOf(text: string) {
  return splitMentionSegments(text, [...mentionLabels.value.keys()])
}

/** 命中片段的显示文本：@命中名 → @展示名（无映射则原样保留 token）。 */
function segmentText(segment: { text: string; matchedName?: string }): string {
  if (!segment.matchedName) return segment.text
  return `@${mentionLabels.value.get(segment.matchedName.toLowerCase()) ?? segment.matchedName}`
}
</script>
<template>
  <div class="message-content">
    <span v-if="message.deleted">消息已撤回</span>
    <template v-else-if="message.blocks?.length">
      <template v-for="(block, index) in message.blocks" :key="index">
        <span v-if="block.type === 'text'"><template v-for="(seg, segIndex) in segmentsOf(block.text)" :key="segIndex"><span v-if="seg.mention" class="message-mention" :data-mention="seg.text">{{ segmentText(seg) }}</span><template v-else>{{ seg.text }}</template></template></span>
        <MessageAttachment v-else-if="block.type === 'attachment'" :ref="(view) => { if (block.attachment.key === props.message.attachment?.key) firstAttachment = view as InstanceType<typeof MessageAttachment> }" :attachment="block.attachment" :isolated="block.attachment.key !== message.attachment?.key" class="message-inline-media" />
      </template>
    </template>
    <template v-else>
      <span v-if="message.content"><template v-for="(seg, segIndex) in segmentsOf(message.content)" :key="segIndex"><span v-if="seg.mention" class="message-mention" :data-mention="seg.text">{{ segmentText(seg) }}</span><template v-else>{{ seg.text }}</template></template></span>
      <MessageAttachment v-if="message.attachment" ref="firstAttachment" :attachment="message.attachment" />
    </template>
  </div>
</template>
<style scoped>
.message-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--unself-font-size-base); line-height: 1.6; }
.message-mention { color: var(--unself-color-primary); background: var(--unself-color-primary-soft); border-radius: var(--unself-radius-sm); padding: 0 var(--unself-space-1); }
.message-inline-media { display: inline-flex; vertical-align: middle; margin: var(--unself-space-1); white-space: normal; }
</style>
