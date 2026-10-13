<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Source: shadcn-vue Context Menu composition, powered by Reka UI.
import { ref, watch } from 'vue'
import type { MenuAction } from './context-menu-types'
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem } from 'reka-ui'
const props = withDefaults(defineProps<{ items: MenuAction[]; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ select: [id: string] }>()
const open = ref(false)
let trigger: HTMLElement | null = null
watch(() => props.disabled, (disabled) => { if (disabled) open.value = false })
function keyboard(event: KeyboardEvent) {
  if (props.disabled || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom }))
}
function remember(event: MouseEvent | PointerEvent) { trigger = event.currentTarget as HTMLElement }
function restore(event: Event) {
  event.preventDefault()
  if (trigger?.isConnected) trigger.focus({ preventScroll: true })
}
</script>
<template>
  <ContextMenuRoot v-model:open="open" :modal="false">
    <ContextMenuTrigger as-child :disabled="disabled || !items.length" :tabindex="disabled ? undefined : 0" :aria-haspopup="disabled ? undefined : 'menu'" @keydown="keyboard" @contextmenu="remember" @pointerdown="remember">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuPortal>
      <ContextMenuContent class="u-context-menu" :collision-padding="8" aria-label="消息操作" @close-auto-focus="restore">
        <ContextMenuItem v-for="item in items" :key="item.id" class="u-context-item" :class="{ 'u-context-danger': item.destructive }" @select="emit('select', item.id)">
          <component :is="item.icon" v-if="item.icon" :size="16" aria-hidden="true" />{{ item.label }}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
<style>
.u-context-menu { z-index:100; min-width:11rem; max-width:calc(100vw - var(--unself-space-4)); padding:var(--unself-space-1); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-md); background:var(--unself-color-surface); color:var(--unself-color-text); box-shadow:var(--unself-shadow-pop); animation:menu-enter var(--unself-duration-fast) var(--unself-ease-out); }
.u-context-item { display:flex; align-items:center; gap:var(--unself-space-2); padding:var(--unself-space-2) var(--unself-space-3); border-radius:var(--unself-radius-sm); font-size:var(--unself-font-size-sm); cursor:pointer; outline:none; user-select:none; }
.u-context-item[data-highlighted] { background:var(--unself-color-surface-active); }
.u-context-danger { color:var(--unself-color-danger); }
@keyframes menu-enter { from { opacity:0; transform:translateY(2px); } to { opacity:1; transform:translateY(0); } }
@media (prefers-reduced-motion: reduce) { .u-context-menu { animation:none; } }
</style>
