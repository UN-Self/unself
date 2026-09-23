// SPDX-License-Identifier: AGPL-3.0-only
/**
 * v-motion（@vueuse/motion）接入层：契约令牌驱动 + prefers-reduced-motion 降级。
 *
 * 动效数值唯一来源 = 契约令牌（--unself-duration-* / --unself-ease-* / --unself-motion-*）。
 * @vueuse/motion 的 transition 是 popmotion 数值（duration ms / ease 数组），不能直接吃 CSS
 * cubic-bezier 字符串 → 本模块在运行时把令牌值解析成 motion 参数（getComputedStyle 读 :root），
 * 并在 reduced-motion 或无 DOM 环境下降级（duration 0 / 静态变体）。
 *
 * 用法（组件内）：
 *   const { variants, apply } = motionVariants()
 *   useMotion(el, { initial: variants.initial, enter: variants.enter })
 */
import type { CSSProperties } from 'vue'

/** 令牌驱动变体集（initial/enter；数值全部运行时取自契约令牌）。 */
export interface TokenVariants {
  initial: Record<string, unknown>
  enter: Record<string, unknown>
  [key: string]: Record<string, unknown> | undefined
}

interface MotionParams {
  durationMs: number
  ease: [number, number, number, number]
  liftPx: number
  pressScale: number
  /** spring 回弹系数（由 press-scale 推导：scale 0.93 → 回弹 1/0.93≈1.075，无新硬编码）。 */
  spring: number
}

/** 参数就绪判定：ease/lift/spring 至少一项拿到令牌值才算就绪（duration 缺失单独允许＝reduced 语义）。 */
export interface ResolvedMotion {
  params: MotionParams
  /** 契约令牌是否就绪（--unself-ease-out 可解析即视为就绪）。 */
  ready: boolean
}

let cached: ResolvedMotion | null = null

/** cubic-bezier(x1,y1,x2,y2) 字符串 → popmotion ease 四元组；解析不出 = null（由调用方判就绪）。 */
function parseCubicBezier(value: string): [number, number, number, number] | null {
  const m = /cubic-bezier\(([^)]+)\)/.exec(value)
  if (!m) return null
  const parts = m[1]!.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return parts as [number, number, number, number]
}

/** 时长解析：ms/s 两种单位；无单位数字按 ms；解析不出 = 0。 */
export function parseDuration(value: string): number {
  const t = value.trim()
  if (!t) return 0
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(t)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return m[2] === 's' ? n * 1000 : n
}

function pxOf(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析契约令牌（:root computed style）→ motion 数值参数。
 * SSR/无 DOM/令牌未注入 = ready:false（调用方自行降级，不固化假值）。
 */
function resolveParams(): ResolvedMotion {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { params: { durationMs: 0, ease: [0, 0, 0, 0], liftPx: 0, pressScale: 1, spring: 1 }, ready: false }
  }
  const root = document.documentElement
  if (!root) return { params: { durationMs: 0, ease: [0, 0, 0, 0], liftPx: 0, pressScale: 1, spring: 1 }, ready: false }
  const css = getComputedStyle(root)
  const ease = parseCubicBezier(css.getPropertyValue('--unself-ease-out'))
  if (!ease) {
    // 令牌未注入（main.ts 保证先注入主题再挂载；此处只是最后防线）——显式未就绪
    return { params: { durationMs: 0, ease: [0, 0, 0, 0], liftPx: 0, pressScale: 1, spring: 1 }, ready: false }
  }
  const slow = parseDuration(css.getPropertyValue('--unself-duration-slow'))
  const fast = parseDuration(css.getPropertyValue('--unself-duration-fast'))
  const liftPx = pxOf(css.getPropertyValue('--unself-motion-lift-y'))
  const pressScale = Number.parseFloat(css.getPropertyValue('--unself-motion-press-scale'))
  const scale = Number.isFinite(pressScale) && pressScale > 0 ? pressScale : 1
  return {
    params: {
      durationMs: slow || fast,
      ease,
      liftPx,
      pressScale: scale,
      // 回弹系数：由契约 press-scale 推导（压下去多少按比例弹回来），非独立硬编码
      spring: 1 / scale,
    },
    ready: true,
  }
}

/** reduced-motion 判定（SSR 恒 false；matchMedia 缺失恒 false）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 构造令牌驱动的入场变体（lift+fade）。
 * reduced-motion → duration 0（瞬时到位，状态不丢、只是不动）。
 */
export function liftFadeVariants(options?: { reduced?: boolean }): TokenVariants {
  const reduced = options?.reduced ?? prefersReducedMotion()
  const { params: { durationMs, ease, liftPx }, ready } = resolveParamsIntoCache()
  if (reduced || !ready) {
    // reduced-motion 或令牌未就绪 → 瞬时到位（状态不丢，只是不动；不猜数值）
    return {
      initial: { opacity: 1, y: 0, transition: { duration: 0 } },
      enter: { opacity: 1, y: 0, transition: { duration: 0 } },
    }
  }
  return {
    initial: { opacity: 0, y: liftPx, transition: { duration: durationMs, ease } },
    enter: { opacity: 1, y: 0, transition: { duration: durationMs, ease } },
  }
}

/** 面板开合变体（beUI Morph Select 连续变体语义；数值全出自契约令牌，见实现注释）。 */
export function panelVariants(options?: { reduced?: boolean }): TokenVariants {
  const reduced = options?.reduced ?? prefersReducedMotion()
  const { params: { durationMs, ease, liftPx, pressScale }, ready } = resolveParamsIntoCache()
  if (reduced || !ready) {
    return {
      initial: { opacity: 1, scaleX: 1, scaleY: 1, y: 0, transition: { duration: 0 } },
      enter: { opacity: 1, scaleX: 1, scaleY: 1, y: 0, transition: { duration: 0 } },
    }
  }
  // beUI Morph Select「连续变体」语义，数值全部出自契约令牌：
  // scaleY 初始 = press-scale（0.93），scaleX 初始 = 1-(1-press-scale)/2 = 0.965（同一压缩率的一半，无独立魔数）
  // y 初始 = -lift-y（向上收合一个浮起位），enter 全部归位。
  const scaleY0 = pressScale
  const scaleX0 = 1 - (1 - pressScale) / 2
  return {
    initial: { opacity: 0, scaleX: scaleX0, scaleY: scaleY0, y: -liftPx, transition: { duration: durationMs, ease } },
    enter: { opacity: 1, scaleX: 1, scaleY: 1, y: 0, transition: { duration: durationMs, ease } },
  }
}

/** 指示 pop（勾选/单选选中瞬间的 press-scale 家族）。 */
export function popVariants(options?: { reduced?: boolean }): TokenVariants {
  const reduced = options?.reduced ?? prefersReducedMotion()
  const { params: { durationMs, ease, pressScale, spring }, ready } = resolveParamsIntoCache()
  if (reduced || !ready) {
    return {
      initial: { scale: 1, transition: { duration: 0 } },
      enter: { scale: 1, transition: { duration: 0 } },
    }
  }
  // 初压 = press-scale（0.93），回弹 = spring（1/press-scale ≈ 1.075）——同一契约参数两个方向
  return {
    initial: { scale: pressScale, transition: { duration: durationMs, ease } },
    enter: { scale: spring, transition: { duration: durationMs, ease } },
  }
}

function resolveParamsIntoCache(): ResolvedMotion {
  // 缓存只在「令牌就绪」时固化；未就绪结果不缓存——主题注入晚于首次调用也能拿到值
  if (!cached || !cached.ready) cached = resolveParams()
  return cached
}

/**
 * v-motion 可用性检测：@vueuse/motion 的 style 绑定需要真实 CSSStyleDeclaration
 * （jsdom 的 el.style[key] 读 undefined 会崩）。检测到即跳过 useMotion——
 * 真实浏览器全量走 v-motion；测试环境退回 CSS 静态过渡（行为等价）。
 */
export function motionAvailable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const probe = document.createElement('div')
  if (!probe.style) return false
  try {
    const keys = Object.keys(probe.style)
    return keys.length > 0 && probe.style['color' as never] !== undefined
  } catch {
    return false
  }
}

/** 测试钩子：清缓存（令牌注入晚于首次调用时用）。 */
export function resetMotionCache(): void {
  cached = null
}

/** 供类型引用（vue CSSProperties 值域）。 */
export type MotionStyle = CSSProperties
