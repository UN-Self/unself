<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/** Vue counterpart of beUI Message: direction and row semantics stay reusable. */
withDefaults(defineProps<{ mine?: boolean }>(), { mine: false })
</script>

<template>
  <article class="u-message" :class="{ 'u-message-mine': mine }" data-slot="message">
    <slot />
  </article>
</template>

<style scoped>
.u-message { display:flex; align-items:flex-start; gap:var(--unself-space-2); width:100%; }
.u-message-mine { flex-direction:row-reverse; }
</style>
