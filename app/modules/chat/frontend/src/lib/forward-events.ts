// SPDX-License-Identifier: AGPL-3.0-only

import type { InjectionKey, Ref } from 'vue'

/**
 * #347 转发成功的通知通道（App → MessageList，provide/inject 跳过 ChatLayout 中间层）：
 * 根层转发整体成功时 +1，MessageList watch 它清空勾选并退出多选；失败不变，勾选保留可重试。
 */
export const forwardSuccessTickKey: InjectionKey<Ref<number>> = Symbol('forwardSuccessTick')
