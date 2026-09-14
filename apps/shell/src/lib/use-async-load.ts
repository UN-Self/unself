// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 异步加载三态组合式（#142，评审报告 #138 ①）：
 * admin 五页（Members/Invites/Modules/Audit/Settings）的加载样板收敛——
 * phase（loading/ready/error）+ loadError + load()（失败卡重试/重新加载）单点实现。
 *
 * 行为约定（与历史页面实现逐一一致，#142 行为零变化）：
 * - 初始 phase = 'loading'；immediate（默认 true）时挂载即 load()
 * - load()：phase → 'loading' → 成功 data = 结果 + 'ready'；失败 loadError = err + 'error'
 * - loadError 保留最后一次错误对象（ApiError：message/requestId/detail 给错误卡），
 *   成功后置 null
 */

import { onMounted, ref, type Ref } from 'vue'

/** 加载三态（与 admin 五页既有 phase 语义一致）。 */
export type AsyncLoadPhase = 'loading' | 'ready' | 'error'

export interface AsyncLoad<T> {
  phase: Ref<AsyncLoadPhase>
  loadError: Ref<unknown | null>
  data: Ref<T | null>
  /** 重新加载（失败卡重试/手动刷新共用，单一实现）。 */
  load(): Promise<void>
}

export function useAsyncLoad<T>(fetcher: () => Promise<T>, options?: { immediate?: boolean }): AsyncLoad<T> {
  const phase = ref<AsyncLoadPhase>('loading')
  const loadError = ref<unknown | null>(null)
  const data = ref<T | null>(null) as Ref<T | null>

  async function load(): Promise<void> {
    phase.value = 'loading'
    try {
      data.value = await fetcher()
      loadError.value = null
      phase.value = 'ready'
    } catch (err) {
      loadError.value = err
      phase.value = 'error'
    }
  }

  if (options?.immediate !== false) {
    onMounted(load)
  }

  return { phase, loadError, data, load }
}
