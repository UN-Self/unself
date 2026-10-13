<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref } from 'vue'
import type { Message } from '../lib/types'
import MessageAttachment from './MessageAttachment.vue'
const props = defineProps<{ message: Message }>()
const firstAttachment = ref<InstanceType<typeof MessageAttachment> | null>(null)
defineExpose({ preview: () => firstAttachment.value?.preview() })
</script>
<template>
  <div class="message-content">
    <span v-if="message.deleted">消息已撤回</span>
    <template v-else-if="message.blocks?.length">
      <template v-for="(block, index) in message.blocks" :key="index">
        <span v-if="block.type === 'text'">{{ block.text }}</span>
        <MessageAttachment v-else :ref="(view) => { if (block.attachment.key === props.message.attachment?.key) firstAttachment = view as InstanceType<typeof MessageAttachment> }" :attachment="block.attachment" :isolated="block.attachment.key !== message.attachment?.key" class="message-inline-media" />
      </template>
    </template>
    <template v-else>
      <span v-if="message.content">{{ message.content }}</span>
      <MessageAttachment v-if="message.attachment" ref="firstAttachment" :attachment="message.attachment" />
    </template>
  </div>
</template>
<style scoped>
.message-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--unself-font-size-base); line-height: 1.6; }
.message-inline-media { display: inline-flex; vertical-align: middle; margin: var(--unself-space-1); white-space: normal; }
</style>
