// SPDX-License-Identifier: AGPL-3.0-only
import { nextTick, ref } from 'vue'

/**
 * 模态弹窗焦点管理（#347 M2）：打开时聚焦卡内首个可聚焦元素（无则聚焦卡片本体）、
 * Tab/Shift+Tab 圈禁在卡内循环、关闭时把焦点还给打开前的元素。
 * ForwardDialog / ForwardBundleView 共用（ReadReceipts 后续可同接）。
 */
export function useModalFocus(isOpen: () => boolean) {
  const cardRef = ref<HTMLElement | null>(null)
  let previouslyFocused: HTMLElement | null = null

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

  async function focusIn(): Promise<void> {
    await nextTick()
    const card = cardRef.value
    if (!card) return
    ;(card.querySelector<HTMLElement>(FOCUSABLE) ?? card).focus()
  }

  /** 打开时调用（watch open）：记下原焦点并聚焦卡内。 */
  function onOpen(): void {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void focusIn()
  }

  /** 关闭时调用：还焦。 */
  function onClose(): void {
    previouslyFocused?.focus()
    previouslyFocused = null
  }

  /** 挂在卡片的 @keydown 上：Tab 圈禁（首尾循环）。 */
  function trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !isOpen()) return
    const card = cardRef.value
    if (!card) return
    const focusables = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!focusables.length) {
      event.preventDefault()
      card.focus()
      return
    }
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || active === card || !card.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  /** 模板函数 ref（:ref="setCardEl"）：绑定卡根元素（VNodeRef 签名收 Element | ComponentPublicInstance | null）。 */
  function setCardEl(el: unknown): void {
    cardRef.value = el instanceof HTMLElement ? el : null
  }

  return { setCardEl, onOpen, onClose, trapTab }
}
