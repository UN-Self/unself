<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { File, X } from 'lucide-vue-next'
import { UButton, UCard } from '@unself/ui'

const props = defineProps<{ file: globalThis.File; busy: boolean; error: string }>()
defineEmits<{ remove: [] }>()
const preview = ref('')
const failed = ref(false)
const kind = computed(() => props.file.type.split('/')[0] ?? '')
const size = computed(() => props.file.size >= 1024 * 1024
  ? `${(props.file.size / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(props.file.size / 1024))} KB`)
function release() {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = ''
}
watch(() => props.file, (file) => {
  release()
  failed.value = false
  if (['image', 'video', 'audio'].includes(kind.value) && typeof URL.createObjectURL === 'function') preview.value = URL.createObjectURL(file)
}, { immediate: true })
onBeforeUnmount(release)
</script>

<template>
  <UCard class="pending-attachment" padding="none" data-test="pending-file">
    <img v-if="preview && !failed && kind === 'image'" :src="preview" :alt="file.name" class="pending-media" @error="failed = true" />
    <video v-else-if="preview && !failed && kind === 'video'" :src="preview" controls preload="metadata" class="pending-media" @error="failed = true" />
    <audio v-else-if="preview && !failed && kind === 'audio'" :src="preview" controls preload="metadata" class="pending-audio" @error="failed = true" />
    <File v-else :size="24" aria-hidden="true" />
    <div class="pending-description">
      <span class="pending-name">{{ file.name }}</span>
      <span class="pending-hint">{{ size }} · {{ busy ? '正在发送…' : '待发送' }}</span>
      <span v-if="failed" class="pending-hint">无法预览，仍可作为文件发送</span>
      <span v-if="error" role="alert" class="pending-error">{{ error }}。附件已保留，请点击发送重试。</span>
    </div>
    <UButton variant="ghost" size="sm" type="button" :disabled="busy" aria-label="移除文件" data-test="clear-file" @click="$emit('remove')">
      <X :size="18" aria-hidden="true" />
    </UButton>
  </UCard>
</template>

<style scoped>
.pending-attachment {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--unself-space-2);
  padding: var(--unself-space-2);
  margin-bottom: var(--unself-space-2);
}
.pending-media {
  width: 6rem;
  height: 5rem;
  object-fit: contain;
  border-radius: var(--unself-radius-sm);
  background: var(--unself-color-surface);
}
.pending-audio { width: 100%; }
.pending-description { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--unself-space-1); }
.pending-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--unself-font-size-sm); }
.pending-hint { font-size: var(--unself-font-size-xs); color: var(--unself-color-text-secondary); }
.pending-error { font-size: var(--unself-font-size-sm); color: var(--unself-color-danger); overflow-wrap: anywhere; }
</style>
