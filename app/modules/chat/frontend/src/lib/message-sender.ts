// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageSender } from './types'

/**
 * 发送者是否本系统用户。worker 对外部桥接消息下发 kind='external'、id 为字符串、username 为空，
 * 形状未在 MessageSender 里声明（只声明了 local）——按 @ 提及前先判这一条，外部发送者不可 @。
 */
export function isLocalSender(sender: MessageSender): boolean {
  return (sender.kind as string) === 'local'
}
