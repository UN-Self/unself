// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 弹层焦点助手（#192 F5 弹层可达性）：
 * 三契约一刀切实现——打开时焦点入内 / 关闭后焦点回触发元素 / Esc 关闭。
 * 复用面：邀请生成弹层、「我的」动作单、站内确认弹层（#192 F6）。
 * 实现：keydown 监听 Esc + Tab 循环（焦点陷阱）；陷阱只圈「弹层内可聚焦元素」，
 * v-if 分支切换后的动态节点在 trap 处理时实时查询（不缓存清单）。
 * 测试语义：行为断言（document.activeElement / keydown 后 open=false），见 admin-pages/App 测试。
 */
import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** 表单控件与链接等可聚焦元素（不含 disabled）。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 弹层焦点管理（open 翻转自动生效）：
 * - open=true：nextTick 后焦点移入弹层首个可聚焦元素（无则弹层容器自身，需带 tabindex="-1"）
 * - open=false：焦点回触发元素（记 open 前的 activeElement）
 * - Esc：关闭（open.value = false）
 * - Tab：末元素按下 → 回首元素；首元素 shift+Tab → 去末元素（循环陷阱）
 * 返回的 onKeydown 挂在弹层容器（@keydown）或 document（open 时全局 Esc 兜底）。
 */
export function useLayerFocus(open: Ref<boolean>, layer: () => HTMLElement | null): {
  onKeydown: (event: KeyboardEvent) => void
} {
  let restoreTo: HTMLElement | null = null

  async function focusIn(): Promise<void> {
    await nextTick()
    const el = layer()
    if (!el) return
    const first = el.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? el).focus()
  }

  function focusBack(): void {
    restoreTo?.focus()
    restoreTo = null
  }

  /** keydown 统一入口：Esc 关闭 + Tab 循环陷阱。 */
  function onKeydown(event: KeyboardEvent): void {
    if (!open.value) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      open.value = false
      return
    }
    if (event.key === 'Tab') {
      const el = layer()
      if (!el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      )
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement as HTMLElement | null
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && (active === first || !el.contains(active))) {
        event.preventDefault()
        last.focus()
      }
    }
  }

  watch(open, (now, was) => {
    if (now && !was) {
      restoreTo = (document.activeElement as HTMLElement | null) ?? null
      void focusIn()
    } else if (!now && was) {
      focusBack()
    }
  })

  onBeforeUnmount(() => {
    restoreTo = null
  })

  return { onKeydown }
}
