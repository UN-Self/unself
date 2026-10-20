<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import UCard from './card.vue'

/**
 * 受控翻页卡片：唯一受控状态是 `flipped`（false = 前页，true = 后页，默认 false）。
 * 内容按插槽分页——`#front` / `#back` 两页 + `#corner` 折角上的透明交互区；
 * 两页始终挂载（翻页只改变哪页可见），未显示的那页 `inert` + `aria-hidden`，退出键盘与辅助技术导航。
 * 折角与页背共用一条折线：`--unself-page-fold-distance` 同时驱动前页的缺口裁切与反折页背，
 * 翻页 = 该值从折角尺寸插值到「页宽 + 页高」（`--unself-page-turn-progress` 0→1）。
 * 页宽高由容器实测（ResizeObserver）写进 `--unself-page-width/height`，折线按实测尺寸算；
 * 页背只画几何、不放文字，故不存在镜像问题；折角交互区固定 `--unself-page-fold-size` 见方，不随动画位移。
 * 仅注入契约令牌时仍可独立使用；壳的翻页令牌可覆盖组件默认值。
 * 动效参数全部取自 tokens，`prefers-reduced-motion: reduce` 下翻页退化为瞬切。
 */
withDefaults(defineProps<{ flipped?: boolean }>(), { flipped: false })

const pages = ref<HTMLElement | null>(null)
const dimensions = ref<Record<string, string>>({})
let observer: ResizeObserver | undefined

onMounted(() => {
  if (!pages.value) return
  const measure = () => {
    const bounds = pages.value?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    dimensions.value = {
      '--unself-page-width': `${bounds.width}px`,
      '--unself-page-height': `${bounds.height}px`,
    }
  }
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(pages.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <UCard padding="none" class="u-flip-book" :class="{ 'u-flip-book-open': flipped }">
    <div ref="pages" class="u-flip-pages" :style="dimensions">
      <div
        class="u-flip-face u-flip-back"
        :inert="!flipped || undefined"
        :aria-hidden="!flipped || undefined"
      >
        <slot name="back" />
      </div>
      <div class="u-flip-leaf">
        <div
          class="u-flip-face u-flip-front"
          :inert="flipped || undefined"
          :aria-hidden="flipped || undefined"
        >
          <slot name="front" />
        </div>
      </div>
      <div class="u-flip-curl" aria-hidden="true">
        <div class="u-flip-page-reverse" />
      </div>
      <div
        class="u-flip-corner"
        :inert="flipped || undefined"
        :aria-hidden="flipped || undefined"
      >
        <slot name="corner" />
      </div>
    </div>
  </UCard>
</template>

<style>
/* 数值插值注册随组件加载，独立消费方无需引入壳样式。 */
@property --unself-page-turn-progress {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}
</style>

<style scoped>
.u-flip-book {
  /* 固定卡片轮廓，斜向翻出的纸页不撑出横向滚动条。 */
  overflow: hidden;
  box-shadow: var(--unself-shadow-pop);
}
.u-flip-pages {
  position: relative;
  display: grid;
  --unself-page-turn-progress: 0;
  /* 0 就已经反折了一个页角；同一距离同时驱动前页缺口与反折页背。 */
  --unself-page-fold-distance: calc(
    var(--unself-page-fold-size, calc(var(--unself-space-8) * 4)) +
    var(--unself-page-turn-progress) * (
      var(--unself-page-width, calc(var(--unself-space-8) * 16)) +
      var(--unself-page-height, calc(var(--unself-space-8) * 16)) -
      var(--unself-page-fold-size, calc(var(--unself-space-8) * 4))
    )
  );
  transition: --unself-page-turn-progress calc(var(--unself-duration-slow) + var(--unself-duration-normal)) var(--unself-ease-page-turn, var(--unself-ease-out));
}
.u-flip-book-open .u-flip-pages {
  --unself-page-turn-progress: 1;
}
.u-flip-leaf {
  position: relative;
  display: grid;
  grid-area: 1 / 1;
  min-width: 0;
  z-index: 1;
  /* 折线 x - y = 页宽 - 反折距离；裁切与页背始终共用这条线。 */
  clip-path: polygon(
    0 clamp(0px, calc(var(--unself-page-fold-distance) - var(--unself-page-width, calc(var(--unself-space-8) * 16))), 100%),
    clamp(0px, calc(100% - var(--unself-page-fold-distance)), 100%) clamp(0px, calc(var(--unself-page-fold-distance) - var(--unself-page-width, calc(var(--unself-space-8) * 16))), 100%),
    clamp(0px, calc(100% + var(--unself-page-height, calc(var(--unself-space-8) * 16)) - var(--unself-page-fold-distance)), 100%) clamp(0px, var(--unself-page-fold-distance), 100%),
    clamp(0px, calc(100% + var(--unself-page-height, calc(var(--unself-space-8) * 16)) - var(--unself-page-fold-distance)), 100%) 100%,
    0 100%
  );
}
.u-flip-book-open .u-flip-leaf {
  pointer-events: none;
}
.u-flip-face {
  grid-area: 1 / 1;
  min-width: 0;
  background: var(--unself-color-surface);
}
.u-flip-face[inert] {
  pointer-events: none;
  user-select: none;
}
.u-flip-curl {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  filter: drop-shadow(calc(-1 * var(--unself-space-1)) var(--unself-space-1) var(--unself-space-2) color-mix(in srgb, var(--unself-color-text) 10%, transparent));
}
.u-flip-page-reverse {
  position: absolute;
  top: 0;
  right: 0;
  width: var(--unself-page-fold-distance);
  height: var(--unself-page-fold-distance);
  border-left: 1px solid var(--unself-color-border);
  border-bottom: 1px solid var(--unself-color-border);
  border-bottom-left-radius: var(--unself-radius-lg);
  clip-path: polygon(0 0, 100% 100%, 0 100%);
  /* 页背、弯曲高光、折线均随同一张纸扩展，不切换另一套动画图形。 */
  background: linear-gradient(45deg,
    var(--unself-color-surface-hover),
    var(--unself-color-surface) calc(50% - var(--unself-space-3)),
    var(--unself-color-surface-active) calc(50% - var(--unself-space-1)),
    var(--unself-color-border) calc(50% - 1px),
    var(--unself-color-surface) 50%
  );
}
.u-flip-corner {
  position: absolute;
  top: 0;
  right: 0;
  width: var(--unself-page-fold-size, calc(var(--unself-space-8) * 4));
  height: var(--unself-page-fold-size, calc(var(--unself-space-8) * 4));
  z-index: 3;
  /* 透明交互区；可见标识属于真实后页，翻页过程中始终留在原位。 */
}
.u-flip-corner[inert] {
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .u-flip-pages {
    transition: none;
  }
}
</style>
