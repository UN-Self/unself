// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块级实例计数：跨 app 唯一 id 种子。
 * （Vue useId 只保证单 app 内唯一；下拉这类带 id 的控件在多实例/多 app 挂载下会撞 id，
 *  aria-controls/aria-activedescendant 指向错误节点。）
 */
let seq = 0

export function nextInstanceId(): number {
  seq += 1
  return seq
}
