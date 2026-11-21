// SPDX-License-Identifier: AGPL-3.0-only
export type RichInputPart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; id: string }
  /** 提及原子：编辑器显示 @displayName，纯文本序列化输出 @username（token 与显示分离）。 */
  | { type: 'mention'; id: number; username: string; displayName: string }
