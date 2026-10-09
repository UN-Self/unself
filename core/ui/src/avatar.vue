<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref, watch } from 'vue'
/** shadcn Avatar 的 image/fallback 结构；尺寸、颜色和圆角来自 Unself tokens。 */
const props = withDefaults(defineProps<{ src?: string; name: string; size?: 'sm' | 'md' | 'lg' }>(), { src: '', size: 'md' })
const failed = ref(false)
watch(() => props.src, () => { failed.value = false })
</script>
<template>
  <span class="u-avatar" :class="`u-avatar-${size}`" aria-hidden="true">
    <img v-if="src && !failed" :src="src" alt="" @error="failed = true">
    <span v-else>{{ name.trim().charAt(0) || '?' }}</span>
  </span>
</template>
<style scoped>
.u-avatar { display: inline-flex; align-items: center; justify-content: center; flex: none; overflow: hidden; border-radius: var(--unself-radius-full); background: var(--unself-color-primary-soft); color: var(--unself-color-primary); font-weight: 600; }
.u-avatar-sm { width: var(--unself-space-6); height: var(--unself-space-6); font-size: var(--unself-font-size-xs); }
.u-avatar-md { width: calc(var(--unself-space-5) * 2); height: calc(var(--unself-space-5) * 2); font-size: var(--unself-font-size-base); }
.u-avatar-lg { width: calc(var(--unself-space-8) * 2); height: calc(var(--unself-space-8) * 2); font-size: var(--unself-font-size-xl); }
.u-avatar img { width: 100%; height: 100%; object-fit: cover; }
</style>
