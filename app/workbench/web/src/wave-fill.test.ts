// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WaveFill, {
  WAVE_AMPLITUDE,
  WAVE_BAND_PX,
  WAVE_BASE_Y,
  WAVE_CYCLES,
  WAVE_DRIFT_MULTIPLIER,
  WAVE_FLAP_DIVISOR,
  WAVE_PATH,
  WAVE_PATH_ANTI,
  WAVE_SVG_WIDTH_PCT,
  WAVE_TESTING_LEVEL,
  WAVE_TRAVEL_PCT,
  WAVE_VIEWBOX_HEIGHT,
  WAVE_VIEWBOX_WIDTH,
} from './components/wave-fill.vue'
import source from './components/wave-fill.vue?raw'

/**
 * WaveFill 几何回归（决策 #100）。
 * jsdom 不算样式、不跑动画；常量从组件 import，关键帧路径从源码对账。
 * 组件的私有自定义属性一律带 -local 后缀（先内联声明后使用，verify-tokens 据此放行）。
 */

/**
 * 去掉样式块里的 /* … *\/ 注释。注释留在块内会被按 `;` 切断成伪声明，
 * 且「注释之前的声明」会被吞进同一条，导致 decl() 查不到（真机踩过）。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 从样式块读单条声明（取第一个命中该声明的块）。改了样式这里必红，逼同步复核。
 * 按 `;` 切分声明后做「名称前缀相等」比对，而不是把 prop 拼进正则：
 * 自定义属性名自带前导 `-`（`--unself-wave-testing-local`），拼进正则后前导 `\s` 会把它当作匹配项吞掉。
 * 逐块扫描而非只认第一块：分组块里查不到的同名声明（如子块的 transition-duration）要落到正确的选择器块上。
 */
function decl(selector: string, prop: string): string {
  // 选择器整体按正则字面量转义（含 [data-level=...] 的方括号与引号）
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blockRe = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  for (const match of source.matchAll(blockRe)) {
    for (const declaration of stripComments(match[1]!).split(';')) {
      const colon = declaration.indexOf(':')
      if (colon < 0) continue
      if (declaration.slice(0, colon).trim() !== prop) continue
      const value = declaration.slice(colon + 1).trim()
      if (!value) throw new Error(`${selector} 的 ${prop} 是空值`)
      return value
    }
  }
  throw new Error(`找不到 ${selector} 的 ${prop}`)
}

/** 取某条 keyframes 的全部拐点声明体。 */
function keyframeSteps(name: string): string[] {
  const block = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\r?\\n\\}`).exec(source)?.[1]
  if (!block) throw new Error(`找不到关键帧 ${name}`)
  return [...block.matchAll(/(?:from|to|\d+%)\s*\{([^}]*)\}/g)].map((m) => m[1]!)
}

/** 把路径串解析成 token 序列（命令字母 + 数字），空白归一——只比语义不比排版。 */
function tokenize(d: string): string[] {
  return d.trim().split(/\s+/).map((t) => (/^[\d.]+$/.test(t) ? String(Number(t)) : t))
}

/** 驻波相位帧：每段 Q 的 [cx, cy, x, y]。 */
function quads(d: string): Array<[number, number, number, number]> {
  const tokens = tokenize(d)
  const out: Array<[number, number, number, number]> = []
  for (let i = 0; i < tokens.length - 4; i++) {
    if (tokens[i] === 'Q') {
      out.push(tokens.slice(i + 1, i + 5).map(Number) as [number, number, number, number])
    }
  }
  return out
}

describe('WaveFill 驻波几何（#100）', () => {
  it('只有一条波线：模板里恰好一个 .wave-fill-wave，旧 bob 层已删（竖向不二次计账）', () => {
    const wrapper = mount(WaveFill, { props: { level: 'rest' } })
    expect(wrapper.findAll('.wave-fill-wave')).toHaveLength(1)
    expect(source).not.toContain('wave-fill-bob')
    expect(source).not.toContain('wave-fill-wave-back')
  })

  it('相位帧结构合法：16 段全显式 Q（d 插值要求两帧命令结构逐段相同，不混 T）', () => {
    for (const d of [WAVE_PATH, WAVE_PATH_ANTI]) {
      expect(quads(d)).toHaveLength(WAVE_CYCLES * 2)
      expect(d).not.toMatch(/\bT\b/)
      expect(d).toContain(`V ${WAVE_VIEWBOX_HEIGHT}`)
      expect(d).toMatch(/H 0 Z$/)
    }
  })

  it('驻波不变量：两帧所有 x 逐点相同、端点恒钉中线（波节不动），仅控制点 y 互补', () => {
    const a = quads(WAVE_PATH)
    const b = quads(WAVE_PATH_ANTI)
    // 命令结构与横坐标逐点相同：振动只走竖向
    expect(b.map(([cx, , x]) => [cx, x])).toEqual(a.map(([cx, , x]) => [cx, x]))
    for (let i = 0; i < a.length; i++) {
      // 段端点（波节）两帧都落回中线
      expect(a[i]![3]).toBe(WAVE_BASE_Y)
      expect(b[i]![3]).toBe(WAVE_BASE_Y)
      // 控制点 y 互补于中线：插值全程竖直穿越，峰谷互换
      expect(a[i]![1] + b[i]![1]).toBe(WAVE_BASE_Y * 2)
      // 控制点 x 落段中央
      expect(a[i]![0]).toBe((i * WAVE_VIEWBOX_WIDTH) / (WAVE_CYCLES * 2) + WAVE_VIEWBOX_WIDTH / (WAVE_CYCLES * 4))
    }
  })

  it('振幅满格 + 单大浪：真实峰谷差 = 波带高 32px，一卡可见 < 1 个周期', () => {
    expect(WAVE_BASE_Y).toBe(WAVE_VIEWBOX_HEIGHT / 2)
    expect(WAVE_AMPLITUDE).toBe(WAVE_VIEWBOX_HEIGHT / 2)
    // 一卡可见周期 = 周期数 × 卡宽占比：< 1 才是整卡一道起伏，≥ 0.5 才有完整波峰
    const visible = (WAVE_CYCLES * 100) / WAVE_SVG_WIDTH_PCT
    expect(visible).toBeGreaterThanOrEqual(0.5)
    expect(visible).toBeLessThan(1)
    const [cx, cy, x, y] = quads(WAVE_PATH)[0]!
    expect(y).toBe(WAVE_BASE_Y)
    // 二次贝塞尔真实极值 = (y0 + 2·cy + y1)/4；控制点必须外推一倍才达标称振幅
    const realCrest = (WAVE_BASE_Y + 2 * cy + y) / 4
    expect(realCrest).toBeCloseTo(WAVE_BASE_Y - WAVE_AMPLITUDE, 6)
    // 相位 B 首段真实谷 = 中线 + 振幅：腹点单程摆 2×振幅 = 波带高
    const [, cyB, , yB] = quads(WAVE_PATH_ANTI)[0]!
    expect((WAVE_BASE_Y + 2 * cyB + yB) / 4).toBeCloseTo(WAVE_BASE_Y + WAVE_AMPLITUDE, 6)
    expect(cx).toBeGreaterThan(0)
    expect(x).toBeGreaterThan(cx)
  })

  it('扑动关键帧与常量同源：from/to 的 d 就是相位 A/B，节奏 ease-in-out alternate', () => {
    const steps = keyframeSteps('wave-fill-flap')
    expect(steps).toHaveLength(2)
    const fromD = /d:\s*path\('([^']+)'\)/.exec(steps[0]!)?.[1]
    const toD = /d:\s*path\('([^']+)'\)/.exec(steps[1]!)?.[1]
    expect(fromD, 'from 帧路径必须 = WAVE_PATH（改常量必须同步关键帧）').toBeDefined()
    expect(toD, 'to 帧路径必须 = WAVE_PATH_ANTI').toBeDefined()
    expect(tokenize(fromD!)).toEqual(tokenize(WAVE_PATH))
    expect(tokenize(toD!)).toEqual(tokenize(WAVE_PATH_ANTI))
    // 单程 = duration-wave / 2：alternate 往返后整周期恰好是 duration-wave
    expect(decl('.wave-fill-wave path', 'animation')).toBe(
      `wave-fill-flap calc(var(--unself-duration-wave) / ${WAVE_FLAP_DIVISOR}) ease-in-out infinite alternate`,
    )
    expect(WAVE_FLAP_DIVISOR).toBe(2)
  })

  it('横移退居背景：仍是整周期相位闭合（循环点不跳变），时长放慢到 wave×2', () => {
    const steps = keyframeSteps('wave-fill-drift')
    expect(steps).toHaveLength(2)
    const from = Number(/translateX\(\s*(-?[\d.]+)%\s*\)/.exec(steps[0]!)?.[1] ?? 0)
    const to = Number(/translateX\(\s*(-?[\d.]+)%\s*\)/.exec(steps[1]!)?.[1] ?? 0)
    const travelPct = Math.abs(to - from)
    expect(travelPct).toBeCloseTo(WAVE_TRAVEL_PCT, 6)
    expect(WAVE_TRAVEL_PCT).toBeCloseTo(100 / WAVE_CYCLES, 9)
    // % 参照 SVG 自身宽（= viewBox 宽）：位移必须折算成整数个周期
    const cyclesPerTravel = ((travelPct / 100) * WAVE_VIEWBOX_WIDTH) / (WAVE_VIEWBOX_WIDTH / WAVE_CYCLES)
    expect(Math.abs(cyclesPerTravel - Math.round(cyclesPerTravel))).toBeLessThan(1e-9)
    expect(cyclesPerTravel).toBe(1)
    // 样式宽 = 常量（可见周期数断言在上一用例），且横移后仍覆盖整卡
    expect(decl('.wave-fill-wave', 'width')).toBe(`${WAVE_SVG_WIDTH_PCT}%`)
    expect(WAVE_SVG_WIDTH_PCT * (1 - travelPct / 100)).toBeGreaterThanOrEqual(100)
    // 横移一周期 = duration-wave × 2，linear 匀速
    expect(decl('.wave-fill-wave', 'animation')).toBe(
      `wave-fill-drift calc(var(--unself-duration-wave) * ${WAVE_DRIFT_MULTIPLIER}) linear infinite`,
    )
    expect(WAVE_DRIFT_MULTIPLIER).toBe(2)
  })

  it('兜底两层：不支持 d 动画时静态波+慢横移；reduced-motion 全部归零', () => {
    // 不支持 d 动画：静态相位 A（path 属性）+ 横移仍在
    const supports = /@supports not \(d: path\(([^)]+)\)\)\s*\{([^}]*)\}/.exec(source)
    expect(supports, '必须有 @supports 降级分支').not.toBeNull()
    expect(supports![2]).toContain('animation: none')
    // reduced-motion：扑动、横移、水位过渡全归零
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(source)?.[1]
    expect(reduced).toBeDefined()
    expect(reduced!.match(/animation:\s*none/g)).toHaveLength(2)
    expect(reduced!).toContain('transition: none')
  })

  it('三档时长都由距离 × duration-wave 算出，不写死秒数', () => {
    const testing = decl(".wave-fill[data-level='testing'] .wave-fill-water", 'transition-duration')
    const full = decl(".wave-fill[data-level='full'] .wave-fill-water", 'transition-duration')
    const sink = decl('.wave-fill-water', 'transition')
    // duration-wave = 走完一整卡高。testing 与回落都是 (0.9 − 波带占比) × wave
    expect(testing).toBe(
      'calc((var(--unself-wave-testing-local) - var(--unself-wave-band-ratio-local)) * var(--unself-duration-wave))',
    )
    // full：(1 − 0.9) × wave，与卡高无关
    expect(full).toBe('calc((1 - var(--unself-wave-testing-local)) * var(--unself-duration-wave))')
    // 回落与涨潮同一段距离，不写死秒数
    expect(sink).toContain(
      'calc((var(--unself-wave-testing-local) - var(--unself-wave-band-ratio-local)) * var(--unself-duration-wave))',
    )
    // 三档都不引用 duration-wave 以外的时长，也不写死毫秒
    for (const value of [testing, full, sink]) {
      expect(value, '时长必须由距离×速度算出，不得写死').not.toMatch(/--unself-duration-slow/)
      expect(value).not.toMatch(/\d+ms/)
    }
    // 时长唯一定义点：三档都引用 --unself-duration-wave
    expect(testing).toContain('--unself-duration-wave')
    expect(full).toContain('--unself-duration-wave')
    expect(sink).toContain('--unself-duration-wave')
  })

  it('速度模型常量与 CSS 变量同源：WAVE_TESTING_LEVEL = --unself-wave-testing-local = 0.9', () => {
    expect(WAVE_TESTING_LEVEL).toBe(0.9)
    // CSS 变量必须与导出常量一致：改常量必须同步样式字面量
    expect(decl('.wave-fill', '--unself-wave-testing-local')).toBe(String(WAVE_TESTING_LEVEL))
    // 波带高 = space-8 = 32px，组件用它换算 --unself-wave-band-ratio-local
    expect(WAVE_BAND_PX).toBe(32)
    // testing 顶缘与阈值同比：改阈值不用手改 translateY
    expect(decl(".wave-fill[data-level='testing'] .wave-fill-water", 'transform')).toBe(
      'translateY(calc((1 - var(--unself-wave-testing-local)) * 100%))',
    )
    // 组件私有变量只在样式块内声明（verify-tokens 靠「内联声明」放行），不进契约
    for (const prop of ['--unself-wave-testing-local', '--unself-wave-band-ratio-local']) {
      expect(decl('.wave-fill', prop), `${prop} 必须在内联声明后才被引用`).not.toBe('')
    }
    // 上涨用 ease-page-turn；回落用下坠曲线
    expect(decl(".wave-fill[data-level='testing'] .wave-fill-water", 'transition-timing-function')).toBe(
      'var(--unself-ease-page-turn)',
    )
    expect(decl('.wave-fill-water', 'transition')).toContain('cubic-bezier(0.7, 0, 0.84, 0)')
  })

  it('看得见：水色不是 surface-active（那种与白卡面几乎同色，波峰看不见）', () => {
    const fill = decl('.wave-fill-wave', 'fill')
    const water = decl('.wave-fill-water', 'background')
    expect(fill).toBe('var(--unself-color-border)')
    expect(water).toBe(fill)
    expect(fill).not.toContain('surface-active')
  })
})

describe('WaveFill 水位三态（#100）', () => {
  it.each(['rest', 'testing', 'full'] as const)('level=%s 透传到 data-level，且装饰层恒 aria-hidden', (level) => {
    const wrapper = mount(WaveFill, { props: { level } })
    expect(wrapper.attributes('data-level')).toBe(level)
    expect(wrapper.attributes('aria-hidden')).toBe('true')
  })

  it('波线用组件导出的 viewBox 与路径（同一真源；静态 d = 相位 A，也是降级形态）', () => {
    const wrapper = mount(WaveFill, { props: { level: 'rest' } })
    const wave = wrapper.find('.wave-fill-wave')
    expect(wave.attributes('viewBox')).toBe(`0 0 ${WAVE_VIEWBOX_WIDTH} ${WAVE_VIEWBOX_HEIGHT}`)
    expect(wave.find('path').attributes('d')).toBe(WAVE_PATH)
  })
})
