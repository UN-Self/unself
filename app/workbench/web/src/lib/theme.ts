// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 壳侧主题取数缝（唯一入口，§6.5.6）：当前返回平台默认主题包（DEFAULT_THEME）；
 * 未来 D1 实例主题（instance_config，短 TTL 缓存）在此接入——上游换值，下游通道 A/B 无感。
 */
import { DEFAULT_THEME, type ThemeTokens } from '@unself/contracts'

/** 当前生效的主题令牌（壳侧唯一取数点；模块侧经通道 A 直注 / 通道 B 握手拿到同值）。 */
export function currentThemeTokens(): ThemeTokens {
  return DEFAULT_THEME
}
