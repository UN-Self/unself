<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
/**
 * 波浪几何常量（决策 #100）。导出给测试对账，不从源码 URL 解析：
 * Windows 上 new URL(file) 会因盘符反斜杠失败。
 * 两相位只在控制点 y 上互补，命令逐段相同，d 才能插值。
 * 控制点外推一倍：二次贝塞尔真实极值 = (y0 + 2·cy + y1)/4，
 * 这样真实峰谷差才等于波带高。
 */
/** viewBox 内的整周期个数。一卡可见周期 = CYCLES × (卡宽 / SVG 宽%) / 100。 */
export const WAVE_CYCLES = 2
/** viewBox 宽（2 整周期 × 240）与高（space-8，垂直 1 单位 = 1px）。 */
export const WAVE_VIEWBOX_WIDTH = 480
export const WAVE_VIEWBOX_HEIGHT = 32
/** 中线与真实振幅。 */
export const WAVE_BASE_Y = 16
export const WAVE_AMPLITUDE = 16
/** 250% 而不是 200%：横移 50% 后仍留 25% 余量，避免亚像素露缝。 */
export const WAVE_SVG_WIDTH_PCT = 250
/** translateX 的 % 参照 SVG 自身宽；50% 折算恰好一个周期。 */
export const WAVE_TRAVEL_PCT = 100 / WAVE_CYCLES
/** 扑动单程除数。alternate 往返后整周期 = duration-wave。 */
export const WAVE_FLAP_DIVISOR = 2
/** 横移一周期 = duration-wave × 2。 */
export const WAVE_DRIFT_MULTIPLIER = 2

/** testing 水体顶缘占卡高的比例。duration-wave = 走完一整卡高。 */
export const WAVE_TESTING_LEVEL = 0.9
/** 波带高（= space-8 = 32px）。CSS 做不了 %÷px，组件量出卡高再写 --unself-wave-band-ratio-local。 */
export const WAVE_BAND_PX = 32

/**
 * @param crestFirst 首段控制点向上还是向下。
 */
function wavePath(crestFirst: boolean): string {
  const segments = WAVE_CYCLES * 2
  const segWidth = WAVE_VIEWBOX_WIDTH / segments
  const ctrlUp = WAVE_BASE_Y - WAVE_AMPLITUDE * 2
  const ctrlDown = WAVE_BASE_Y + WAVE_AMPLITUDE * 2
  let d = `M0 ${WAVE_BASE_Y}`
  for (let i = 0; i < segments; i++) {
    const up = i % 2 === 0 ? crestFirst : !crestFirst
    const cy = up ? ctrlUp : ctrlDown
    const cx = i * segWidth + segWidth / 2
    d += ` Q ${cx} ${cy} ${(i + 1) * segWidth} ${WAVE_BASE_Y}`
  }
  return d + ` V ${WAVE_VIEWBOX_HEIGHT} H 0 Z`
}
/** 相位 A：首段波峰向上。不支持 d 动画时的静态波形。 */
export const WAVE_PATH = wavePath(true)
/** 相位 B：峰谷互换。 */
export const WAVE_PATH_ANTI = wavePath(false)
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 纯装饰水面（决策 #100）。语义由弹窗文字承担，容器恒 aria-hidden。 */
defineProps<{
  /** 水位状态：rest 基线 / testing 测潮（顶缘停在卡高 90%）/ full 满灌。 */
  level: 'rest' | 'testing' | 'full'
}>()

const viewBox = `0 0 ${WAVE_VIEWBOX_WIDTH} ${WAVE_VIEWBOX_HEIGHT}`

/** 波带占容器高的比例。初值按约 320px 容器高，ResizeObserver 随后写入真值。 */
const bandRatio = ref(String(WAVE_BAND_PX / 320))
const rootEl = ref<HTMLElement | null>(null)

onMounted(() => {
  const el = rootEl.value
  if (!el) return
  const sync = (height: number): void => {
    if (height > 0) bandRatio.value = String(Math.min(1, WAVE_BAND_PX / height))
  }
  sync(el.getBoundingClientRect().height)
  if (typeof ResizeObserver === 'undefined') return
  const ro = new ResizeObserver((entries) => sync(entries[0]?.contentRect.height ?? 0))
  ro.observe(el)
  onBeforeUnmount(() => ro.disconnect())
})
</script>

<template>
  <div
    ref="rootEl"
    class="wave-fill"
    :data-level="level"
    :style="{ '--unself-wave-band-ratio-local': bandRatio }"
    aria-hidden="true"
  >
    <div class="wave-fill-water">
      <svg class="wave-fill-wave" :viewBox="viewBox" preserveAspectRatio="none">
        <path :d="WAVE_PATH" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.wave-fill {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  border-radius: inherit;
  /* 水位阈值必须等于 WAVE_TESTING_LEVEL：测试对账字面量，改常量必须同步这里。
     自定义属性固定带 -local 后缀：verify-tokens 的白名单只认契约令牌与 tokens.css 声明的
     --unself-*，组件私有变量靠「本文件内联声明」放行，-local 后缀避免与平台令牌同名混淆。 */
  --unself-wave-testing-local: 0.9;
  /* 组件运行期写入（ResizeObserver）：卡高量出来后覆盖初值。 */
  --unself-wave-band-ratio-local: 0.1;
}
/* 回落：慢起、加速沉底。时长 = (阈值 − 波带占比) × duration-wave。 */
.wave-fill-water {
  position: absolute;
  inset: 0;
  background: var(--unself-color-border);
  transform: translateY(calc(100% - var(--unself-space-8)));
  transition: transform
    calc((var(--unself-wave-testing-local) - var(--unself-wave-band-ratio-local)) * var(--unself-duration-wave))
    cubic-bezier(0.7, 0, 0.84, 0);
}
.wave-fill[data-level='testing'] .wave-fill-water {
  transform: translateY(calc((1 - var(--unself-wave-testing-local)) * 100%));
  transition-duration: calc((var(--unself-wave-testing-local) - var(--unself-wave-band-ratio-local)) * var(--unself-duration-wave));
  transition-timing-function: var(--unself-ease-page-turn);
}
.wave-fill[data-level='full'] .wave-fill-water {
  transform: translateY(0);
  transition-duration: calc((1 - var(--unself-wave-testing-local)) * var(--unself-duration-wave));
  transition-timing-function: var(--unself-ease-page-turn);
}

/* 驻波层：一条波线 + 下方填满水体，不叠第二层。
 * top 负一个波带高——wavePath 的 viewBox 下缘画到 y = 32，负偏移后真实峰恰好抬出到水体上缘。
 * 过 viewBox 上缘（< 0）的部分会被 .wave-fill-water 的 overflow 裁掉，所以 viewBox 要留出这段高度。 */
.wave-fill-wave {
  position: absolute;
  top: calc(-1 * var(--unself-space-8));
  left: 0;
  display: block;
  /* 必须等于 WAVE_SVG_WIDTH_PCT：测试对账字面量，改常量必须同步这里。 */
  width: 250%;
  height: var(--unself-space-8);
  fill: var(--unself-color-border);
  animation: wave-fill-drift calc(var(--unself-duration-wave) * 2) linear infinite;
  will-change: transform;
  shape-rendering: geometricPrecision;
}
/* −50% 必须等于 WAVE_TRAVEL_PCT：测试对账字面量，改常量必须同步这里。 */
@keyframes wave-fill-drift {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}

/* 路径字面量必须等于 WAVE_PATH / WAVE_PATH_ANTI：测试对账字面量，改常量必须同步这里。 */
.wave-fill-wave path {
  animation: wave-fill-flap calc(var(--unself-duration-wave) / 2) ease-in-out infinite alternate;
}
@keyframes wave-fill-flap {
  from {
    d: path('M0 16 Q 60 -16 120 16 Q 180 48 240 16 Q 300 -16 360 16 Q 420 48 480 16 V 32 H 0 Z');
  }
  to {
    d: path('M0 16 Q 60 48 120 16 Q 180 -16 240 16 Q 300 48 360 16 Q 420 -16 480 16 V 32 H 0 Z');
  }
}
/* Chromium 106+ / Safari 17.4+ 才有 d 动画；不支持时保持静态相位 A。 */
@supports not (d: path('M0 0 Q 1 1 2 2')) {
  .wave-fill-wave path {
    animation: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wave-fill-water {
    transition: none;
  }
  .wave-fill-wave {
    animation: none;
  }
  .wave-fill-wave path {
    animation: none;
  }
}
</style>
