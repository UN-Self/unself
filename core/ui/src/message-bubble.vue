<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/** Soft incoming / solid outgoing variants follow beUI MessageBubble semantics. */
withDefaults(defineProps<{ variant?: 'soft' | 'solid' }>(), { variant: 'soft' })
</script>

<template>
  <div class="u-message-bubble" :class="`u-message-bubble-${variant}`" data-slot="message-bubble"><slot /></div>
</template>

<style scoped>
.u-message-bubble { display:flex; flex-direction:column; gap:var(--unself-space-1); align-self:flex-start; padding:var(--unself-space-2) var(--unself-space-3); border-radius:var(--unself-radius-lg); }
.u-message-bubble-soft { background:var(--unself-color-bg); color:var(--unself-color-text); }
.u-message-bubble-solid { align-self:flex-end; background:var(--unself-color-primary-soft); color:var(--unself-color-text); }
</style>
