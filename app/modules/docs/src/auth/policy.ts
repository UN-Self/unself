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
 */

/** 三种角色。owner 是唯一能删的角色，且 owner 优先于成员表里的任何取值。 */
export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

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
 */
export function resolveRole(input: {
  ownerId: string;
  userId: string;
  memberRole?: string | null;
}): Role | null {
  if (input.ownerId === input.userId) return 'owner';
  const memberRole = input.memberRole ?? null;
  if (memberRole === 'editor' || memberRole === 'viewer') return memberRole;
  return null;
}
