<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Paperclip } from 'lucide-vue-next'
import { UImagePreview } from '@unself/ui'
import VoiceBubble from './VoiceBubble.vue'
import { attachmentResourceKey, useAttachmentResource } from '../lib/attachment-resource'
import type { Attachment } from '../lib/types'
const props = defineProps<{ attachment: Attachment }>()
const resource = inject(attachmentResourceKey) ?? useAttachmentResource(() => props.attachment)
const { source, loading, failed: requestFailed } = resource
const failed = ref(false)
const host = ref<HTMLElement | null>(null)
const imageButton = ref<HTMLButtonElement | null>(null)
let observer: IntersectionObserver | null = null
onMounted(() => {
  if (!mediaType.value.startsWith('image/')) return
  if (typeof IntersectionObserver !== 'function') { void resource.load(); return }
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); void resource.load() }
  })
  if (host.value) observer.observe(host.value)
})
onBeforeUnmount(() => observer?.disconnect())
const previewOpen = ref(false)
const mediaType = computed(() => (props.attachment.type.toLowerCase().split(';')[0] ?? '').trim())
watch(() => props.attachment.url, () => { failed.value = false; previewOpen.value = false })
async function preview() {
  if (!mediaType.value.startsWith('image/')) return
  const url = await resource.load()
  if (url && !failed.value) {
    await nextTick()
    imageButton.value?.focus({ preventScroll: true })
    previewOpen.value = true
  }
}
defineExpose({ preview })
</script>
<template>
  <div ref="host" class="attachment" :class="{ 'attachment-pending': !source && mediaType.startsWith('image/') }">
    <template v-if="source && !failed && mediaType.startsWith('image/')">
      <button ref="imageButton" type="button" class="attachment-image" :aria-label="`预览图片：${attachment.name}`" @click="preview">
        <img :src="source" :alt="attachment.name" loading="lazy" decoding="async" @error="failed = true" />
      </button>
      <UImagePreview v-model:open="previewOpen" :src="source" :name="attachment.name" @error="failed = true" />
    </template>
    <video v-else-if="source && !failed && mediaType.startsWith('video/')" :src="source" :aria-label="attachment.name" controls playsinline preload="none" @error="failed = true" />
    <VoiceBubble v-else-if="source && !failed && attachment.kind === 'voice'" :attachment="{ ...attachment, url: source }" @error="failed = true" />
    <audio v-else-if="source && !failed && (mediaType.startsWith('audio/') || attachment.kind === 'audio')" :src="source" :aria-label="attachment.name" controls preload="none" @error="failed = true" />
    <button v-if="!source && !loading && !requestFailed && (mediaType.startsWith('video/') || mediaType.startsWith('audio/') || attachment.kind)" class="attachment-load" type="button" @click="resource.load()">加载播放器</button>
    <span v-if="loading" role="status">正在加载附件…</span>
    <button v-if="requestFailed" class="attachment-load" type="button" @click="resource.load()">加载失败，点击重试</button>
    <p v-if="failed" role="status" class="attachment-error">无法预览，可下载后查看</p>
    <a v-if="failed || requestFailed || !mediaType.startsWith('image/')" class="bubble-file" data-test="bubble-file" :href="source || attachment.url" @click.prevent="resource.download()" :download="attachment.name" target="_blank" rel="noopener">
      <Paperclip :size="14" aria-hidden="true" />
      <span class="attachment-name">{{ attachment.name }}</span>
      <span class="attachment-size">{{ Math.max(1, Math.round((attachment.size || 0) / 1024)) }} KB</span>
    </a>
  </div>
</template>
<style scoped>
.attachment { min-width:0; max-width:100%; display:flex; flex-direction:column; gap:var(--unself-space-2); }
.attachment-pending { min-height:4rem; }
.attachment-image { display:block; max-width:100%; border:0; padding:0; background:transparent; border-radius:var(--unself-radius-md); overflow:hidden; cursor:zoom-in; }
.attachment-image img { display:block; width:auto; max-width:100%; max-height:24rem; object-fit:contain; }
.attachment video { width: min(100%, 28rem); max-height:24rem; border-radius:var(--unself-radius-md); }
.attachment audio { width:20rem; max-width:100%; }
.attachment-load { border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-md); padding:var(--unself-space-3); color:inherit; background:var(--unself-color-surface); cursor:pointer; }
.attachment-image:focus-visible { outline:var(--unself-focus-ring); outline-offset:2px; }
.bubble-file { display:flex; align-items:center; gap:var(--unself-space-2); color:inherit; font-size:var(--unself-font-size-sm); }
.attachment-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.attachment-size { flex-shrink:0; opacity:0.7; font-variant-numeric:tabular-nums; }
.attachment-error { margin:0; font-size:var(--unself-font-size-sm); }
</style>
