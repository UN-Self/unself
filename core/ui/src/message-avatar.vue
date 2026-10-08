<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
defineProps<{ src?: string; name: string }>()
</script>

<template>
  <img v-if="src" class="u-message-avatar" :src="src" alt="" />
  <span v-else class="u-message-avatar u-message-avatar-fallback" aria-hidden="true">{{ name.slice(0, 1) }}</span>
</template>

<style scoped>
.u-message-avatar { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; flex:0 0 32px; border-radius:var(--unself-radius-full); object-fit:cover; }
.u-message-avatar-fallback { background:var(--unself-color-primary-soft); color:var(--unself-color-primary); font-size:var(--unself-font-size-sm); font-weight:600; }
</style>
