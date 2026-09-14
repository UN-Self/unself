// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 假实现：内存 Map 模拟四方法，行为语义与 Stalwart 实现一致。
 * 给 #18/#22 集成测试用的标准件——记录调用历史（calls），不发任何网络请求。
 *
 * #141 分层归位：实现住进 @unself/contracts（mail-provisioner.ts），
 * 本文件只剩 re-export，保住既有导入路径 @unself/stalwart-provisioner。
 */

export {
  createFakeMailProvisioner,
  type FakeMailCall,
  type FakeMailProvisioner,
} from '@unself/contracts';
