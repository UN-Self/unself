<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Reka Dialog supplies focus trapping/Escape/outside dismissal; beUI Image Viewer informs layout.
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui'
import { Download, X } from 'lucide-vue-next'
import { watch } from 'vue'
const props = defineProps<{ open: boolean; src: string; name: string }>()
const emit = defineEmits<{ 'update:open': [open: boolean]; error: [] }>()
let previousFocus: HTMLElement | null = null
watch(() => props.open, (open) => { if (open) previousFocus = document.activeElement as HTMLElement })
function restore(event: Event) {
  event.preventDefault()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
}
</script>
<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="u-image-overlay" />
      <DialogContent class="u-image-dialog" :aria-describedby="undefined" @close-auto-focus="restore">
        <header class="u-image-toolbar">
          <DialogTitle class="u-image-title">{{ name }}</DialogTitle>
          <a :href="src" :download="name" target="_blank" rel="noopener" aria-label="下载图片"><Download :size="20" /></a>
          <DialogClose class="u-image-close" aria-label="关闭图片预览"><X :size="20" /></DialogClose>
        </header>
        <img :src="src" :alt="name" class="u-image-full" @error="emit('error'); emit('update:open', false)" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
<style scoped>
.u-image-overlay { position:fixed; inset:0; z-index:110; background:var(--unself-color-scrim); }
.u-image-dialog { position:fixed; z-index:111; top:50%; left:50%; transform:translate(-50%, -50%); width: min(960px, calc(100vw - var(--unself-space-6))); max-height:calc(100dvh - var(--unself-space-6)); display:flex; flex-direction:column; border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-lg); padding:var(--unself-space-3); background:var(--unself-color-surface); color:var(--unself-color-text); box-shadow:var(--unself-shadow-pop); }
.u-image-toolbar { display:flex; gap:var(--unself-space-3); align-items:center; margin-bottom:var(--unself-space-3); }
.u-image-title { flex:1; min-width:0; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--unself-font-size-base); }
.u-image-toolbar a, .u-image-close { display:grid; place-items:center; flex-shrink:0; width:2.5rem; height:2.5rem; border:0; border-radius:var(--unself-radius-md); background:var(--unself-color-surface-hover); color:var(--unself-color-text); cursor:pointer; }
.u-image-full { display:block; width:100%; min-height:0; object-fit:contain; }
.u-image-close:focus-visible, .u-image-toolbar a:focus-visible { outline:var(--unself-focus-ring); }
</style>
