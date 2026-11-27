// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 角色裁决（issue #358 · §5 数据模型）：owner / editor / viewer 三角色，
 * owner 由 `docs_documents.owner_id` 判定，editor / viewer 来自 `docs_document_members.role`。
 *
 * 本文件只做**纯裁决**（无 IO、无 Hono、无 SQL），所以表还没落地也能把语义锁死：
 * 仓储层（T2）把行读出来，本项目只回答「这个角色能不能做这个动作」。
 *
 * 裁决顺序（#358 定案，端点不得自行发挥）：
 *   401 身份（auth/bearer.ts）→ 404 非成员/不存在/已软删 → 403 是成员但角色不够。
 * 「已软删」「不存在」「非成员」三种情况在响应上完全一致——不泄露文档存在性。
 *
 * 【临时偏离，非正式口径】共享入口尚未实现，无成员行的调用者暂按 `OPEN_ACCESS_ROLE`（只读）
 * 放行，因此读路径上「非成员 404」不成立（写/删仍 403）；成员表脏值仍按非成员处理。
 * 恢复步骤的唯一清单在本模块 README「当前权限状态（临时）」。
 */

/** 三种角色。owner 是唯一能删的角色，且 owner 优先于成员表里的任何取值。 */
export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * 临时放开（#358 收尾期，非正式口径）：文档共享所需的「成员管理接口」与前端「共享」入口
 * 尚未实现，在此之前全部未删除文档对所有持有 docs token 的实例成员只读可见。
 *
 * 只影响「无成员行」的调用者；成员表脏值不参与放开。
 * 恢复步骤的唯一清单见本模块 README「当前权限状态（临时）」（改回 `null` 即可恢复裁决，
 * 另需还原列表 SQL 与测试断言）。
 */
export const OPEN_ACCESS_ROLE: Role | null = 'viewer';

/** 动作词表：读 / 写（新建、保存）/ 删。 */
export const ACTIONS = ['read', 'write', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * 角色 → 动作矩阵（#358 §5 + §6 端点表反推）。改这里等于改权限，必须同步改矩阵用例。
 */
const ROLE_GRANTS: Readonly<Record<Action, readonly Role[]>> = {
  read: ['owner', 'editor', 'viewer'],
  write: ['owner', 'editor'],
  delete: ['owner'],
};

/** 单点判定：角色能否做该动作（null = 非成员）。 */
export function may(role: Role | null, action: Action): boolean {
  if (role === null) return false;
  return ROLE_GRANTS[action].includes(role);
}

/** 裁决结果：allow 或「该回哪个状态码」（401 在认证层已处理，不在此出现）。 */
export type AccessDecision = { allow: true } | { allow: false; status: 403 | 404 };

/**
 * 裁决：非成员 → 404（不是 403，存在性不外泄）；成员但角色不够 → 403；够 → 放行。
 */
export function decide(role: Role | null, action: Action): AccessDecision {
  if (role === null) return { allow: false, status: 404 };
  if (!may(role, action)) return { allow: false, status: 403 };
  return { allow: true };
}

/**
 * 由「文档 owner + 调用者 + 成员表取值」推出角色。纯函数，仓储层把三个值读进来即可。
 *
 * 两条纪律：
 * - owner 优先：owner_id 命中即 owner，成员表里残留的 viewer 行不能把他降级；
 * - 成员表只认 editor / viewer，其他脏值一律当「非成员」（fail-closed，不猜）。
 *
 * 临时：第二、三条不变；只有「没有成员行」（memberRole 为 null）落 `OPEN_ACCESS_ROLE`，
 * 脏值仍按非成员处理。恢复时把该常量改回 null 即可，本函数无需改动。
 */
export function resolveRole(input: {
  ownerId: string;
  userId: string;
  memberRole?: string | null;
}): Role | null {
  if (input.ownerId === input.userId) return 'owner';
  const memberRole = input.memberRole ?? null;
  if (memberRole === 'editor' || memberRole === 'viewer') return memberRole;
  // 原正式口径：return null;（临时放开期间由 OPEN_ACCESS_ROLE 接管，改回 null 即恢复，不必删本行）
  // 临时：只有「无成员行」落临时口径；成员表脏值仍当非成员（fail-closed，不猜）。
  return memberRole === null ? OPEN_ACCESS_ROLE : null;
}
