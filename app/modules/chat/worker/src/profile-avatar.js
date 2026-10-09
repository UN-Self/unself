// SPDX-License-Identifier: GPL-3.0-only
import { publicFileUrl } from './utils.js';

/** Core 缺字段时兼容旧头像；空字符串表示明确移除，不回退到旧图。 */
export function userAvatarUrl(coreUrl, legacyKey) {
  return typeof coreUrl === 'string' ? coreUrl : legacyKey ? publicFileUrl(legacyKey) : '';
}
