// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  liftFadeVariants,
  panelVariants,
  popVariants,
  prefersReducedMotion,
  resetMotionCache,
} from '../src/motion'

/**
 * v-motion 接入层（motion.ts）行为测试：
 * - 变体数值运行时取自契约令牌（注入令牌后解析出对应 ms/px/scale）；
 * - reduced-motion 降级 duration 0（状态不丢，只是不动）；
 * - 无 DOM（SSR）全零安全。
 */

describe('motion.ts：令牌驱动的 v-motion 变体', () => {
  it('令牌注入后：liftFade 读取 duration-slow/ease-out/lift-y 生成 motion 参数', () => {
    document.documentElement.style.setProperty('--unself-duration-slow', '400ms');
    document.documentElement.style.setProperty('--unself-duration-fast', '150ms');
    document.documentElement.style.setProperty('--unself-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)');
    document.documentElement.style.setProperty('--unself-motion-lift-y', '2px');
    document.documentElement.style.setProperty('--unself-motion-press-scale', '0.93');
    resetMotionCache();

    const v = liftFadeVariants({ reduced: false });
    const enter = v.enter as { opacity: number; y: number; transition: { duration: number; ease: number[] } };
    expect(enter.opacity).toBe(1);
    expect(enter.y).toBe(0);
    expect(enter.transition.duration).toBe(400);
    expect(enter.transition.ease).toEqual([0.16, 1, 0.3, 1]);
    const initial = v.initial as { opacity: number; y: number };
    expect(initial.opacity).toBe(0);
    expect(initial.y).toBe(2);
  });

  it('panelVariants：scaleY 初值=press-scale、scaleX 同压缩率一半、y=-lift-y（零硬编码）', () => {
    resetMotionCache();
    const v = panelVariants({ reduced: false });
    const initial = v.initial as { scaleY: number; scaleX: number; y: number };
    const enter = v.enter as { scaleY: number; scaleX: number; transition: { duration: number } };
    expect(initial.scaleY).toBeCloseTo(0.93); // = --unself-motion-press-scale
    expect(initial.scaleX).toBeCloseTo(1 - (1 - 0.93) / 2); // 同一压缩率推导
    expect(initial.y).toBeCloseTo(-2); // = -lift-y
    expect(enter.scaleY).toBe(1);
    expect(enter.scaleX).toBe(1);
    expect(enter.transition.duration).toBe(400);
  });

  it('popVariants：初压=press-scale、回弹=1/press-scale（同一契约参数两方向）', () => {
    resetMotionCache();
    const v = popVariants({ reduced: false });
    const initial = v.initial as { scale: number };
    const enter = v.enter as { scale: number };
    expect(initial.scale).toBeCloseTo(0.93);
    expect(enter.scale).toBeCloseTo(1 / 0.93);
  });

  it('duration 解析：ms 与 s 两种单位（0.4s = 400ms）', async () => {
    const { parseDuration } = await import('../src/motion');
    expect(parseDuration('400ms')).toBe(400);
    expect(parseDuration('0.4s')).toBe(400);
    expect(parseDuration('2s')).toBe(2000);
    expect(parseDuration('150')).toBe(150); // 无单位按 ms
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('abc')).toBe(0);
  });

  it('令牌未就绪：变体瞬时到位（不猜数值）且缓存不固化——后注入令牌可拿到真值', async () => {
    // 清掉 :root 上测试注入的令牌
    for (const name of ['--unself-duration-slow', '--unself-duration-fast', '--unself-ease-out', '--unself-motion-lift-y', '--unself-motion-press-scale']) {
      document.documentElement.style.removeProperty(name);
    }
    resetMotionCache();
    const v0 = liftFadeVariants({ reduced: false });
    expect((v0.enter as { transition: { duration: number } }).transition.duration).toBe(0);
    // 先在未就绪态「预热」缓存，再注入令牌——缓存不得固化未就绪结果
    resetMotionCache();
    const warmed = liftFadeVariants({ reduced: false }); // 未就绪 → duration 0
    expect((warmed.enter as { transition: { duration: number } }).transition.duration).toBe(0);
    document.documentElement.style.setProperty('--unself-duration-slow', '400ms');
    document.documentElement.style.setProperty('--unself-duration-fast', '150ms');
    document.documentElement.style.setProperty('--unself-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)');
    document.documentElement.style.setProperty('--unself-motion-lift-y', '2px');
    document.documentElement.style.setProperty('--unself-motion-press-scale', '0.93');
    const v1 = liftFadeVariants({ reduced: false }); // 未重置缓存也必须拿到新值
    expect((v1.enter as { transition: { duration: number } }).transition.duration).toBe(400);
    resetMotionCache();
  });

  it('reduced-motion → duration 0（瞬时到位；状态不丢）', () => {
    resetMotionCache();
    for (const make of [liftFadeVariants, panelVariants, popVariants]) {
      const v = make({ reduced: true });
      expect((v.enter as { transition: { duration: number } }).transition.duration).toBe(0);
      expect((v.initial as { transition: { duration: number } }).transition.duration).toBe(0);
    }
  });

  it('prefersReducedMotion：显式 matchMedia reduce → true', () => {
    const original = window.matchMedia;
    (window as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes('reduce') });
    try {
      expect(prefersReducedMotion()).toBe(true);
    } finally {
      (window as { matchMedia: unknown }).matchMedia = original;
    }
  });
});
