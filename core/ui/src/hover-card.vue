<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Reka UI HoverCard 受控组合（参照 context-menu.vue 口径）：无样式基元 + tokens。
// 双通道开卡：悬停=预览（openDelay 默认 300ms 防扫过，移出即关）；点击/Tap=钉住
// （跳过延迟常开，Esc/点外/再点解除）。Tab 聚焦等同预览态（无障碍）。
// open = 预览态 || 钉住态，由本基元统一持有；open-change 抛出开合，供浮层类调用方
// 让 Esc 只关最上层（卡片先关、外层浮层后关）。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from 'reka-ui'

const props = withDefaults(defineProps<{ /** 悬停多少毫秒后开卡（默认 300）。 */
  openDelay?: number
  /** 指针离开多少毫秒后关卡（仅预览态）。 */
  closeDelay?: number
  /** 内容是否传送到 body：默认 true（消息流等滚动容器里避免被裁）。
   *  传 false 时内容就地渲染——供 aria-modal 对话框内的触发器使用（传送出去会被读屏忽略）。 */
  portal?: boolean
}>(), { openDelay: 300, closeDelay: 100, portal: true })

/** 预览态（悬停/聚焦触发，移出即关）。 */
const preview = ref(false)
/** 钉住态（点击触发，显式解除）。 */
const pinned = ref(false)
const open = computed(() => preview.value || pinned.value)

const emit = defineEmits<{
  /** 开合状态变化：浮层内嵌资料卡时，外层据此让 Esc 只关最上层。 */
  'open-change': [open: boolean]
}>()
watch(open, (value) => emit('open-change', value))

let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
function clearTimers(): void {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  openTimer = closeTimer = undefined
}
onBeforeUnmount(clearTimers)

function schedulePreview(event: PointerEvent): void {
  // 触屏 tap 也会发 pointerenter：不挂悬停计时，否则钉住解除后 300ms 卡会自己弹开
  if (event.pointerType !== 'mouse') return
  clearTimers()
  openTimer = setTimeout(() => { preview.value = true }, props.openDelay)
}
function scheduleClose(): void {
  clearTimers()
  closeTimer = setTimeout(() => { preview.value = false }, props.closeDelay)
}
/** 聚焦等同预览（键盘用户无悬停）；立即开、失焦即关，不走延迟计时。 */
function focusPreview(): void {
  clearTimers()
  preview.value = true
}
function togglePinned(): void {
  clearTimers()
  preview.value = false
  pinned.value = !pinned.value
}
function unpin(): void {
  pinned.value = false
}
/** Esc 关卡片：预览态与钉住态一起收——只 unpin 时，悬停/聚焦态按 Esc 毫无反应。 */
function closeCard(): void {
  clearTimers()
  preview.value = false
  pinned.value = false
}
</script>

<template>
  <HoverCardRoot :open="open">
    <HoverCardTrigger as-child class="u-hover-trigger"
      @pointerenter="schedulePreview"
      @pointerleave="scheduleClose"
      @focusin="focusPreview"
      @focusout="preview = false"
      @click.prevent="togglePinned"
      @keydown.esc.prevent="closeCard"
    >
      <slot name="trigger" />
    </HoverCardTrigger>
    <HoverCardPortal :disabled="!portal">
      <!-- 指针移到卡片上时取消关闭计时（否则移出触发器的 100ms 后卡片会在指针仍停留时消失） -->
      <HoverCardContent class="u-hover-card" :side-offset="6" :collision-padding="8"
        @pointerenter="clearTimers"
        @pointerleave="scheduleClose"
        @escape-key-down="closeCard"
        @pointer-down-outside="unpin"
      >
        <slot />
      </HoverCardContent>
    </HoverCardPortal>
  </HoverCardRoot>
</template>

<style>
/* 触发器可点击暗示：头像这类非按钮元素也要出 pointer（button 触发器本就有，不冲突） */
.u-hover-trigger { cursor:pointer; }
.u-hover-card { z-index:100; max-width:calc(100vw - var(--unself-space-4)); padding:var(--unself-space-3); border:1px solid var(--unself-color-border); border-radius:var(--unself-radius-lg); background:var(--unself-color-surface); color:var(--unself-color-text); box-shadow:var(--unself-shadow-pop); animation:u-hover-card-enter var(--unself-duration-fast) var(--unself-ease-out); }
@keyframes u-hover-card-enter { from { opacity:0; transform:translateY(2px); } to { opacity:1; transform:translateY(0); } }
@media (prefers-reduced-motion: reduce) { .u-hover-card { animation:none; } }
</style>
