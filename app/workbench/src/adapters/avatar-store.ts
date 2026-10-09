// SPDX-License-Identifier: AGPL-3.0-only
import type { Bindings, CoreApiDependencies } from '../index';
import { r2AvatarStore } from './r2-avatar-store';

/** 默认 R2；其他部署形态在组合根注入自己的存储适配器。 */
export function avatarStore(env: Bindings, dependencies: CoreApiDependencies = {}) {
  if (dependencies.createAvatarStore) return dependencies.createAvatarStore(env);
  return env.PROFILE_FILES ? r2AvatarStore(env.PROFILE_FILES) : null;
}
