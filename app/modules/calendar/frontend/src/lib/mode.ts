// SPDX-License-Identifier: AGPL-3.0-only
import { ref } from 'vue'

/** 运行模式：显式环境变量优先，没写就在启动时探测壳握手。 */
export type Mode = 'mock' | 'live'

const flag = import.meta.env.VITE_USE_MOCK
export const MODE_LOCKED: Mode | null = flag === 'true' ? 'mock' : flag === 'false' ? 'live' : null

export const mode = ref<Mode>(MODE_LOCKED ?? 'mock')
export const isMock = (): boolean => mode.value === 'mock'
