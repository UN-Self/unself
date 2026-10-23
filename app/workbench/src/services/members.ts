// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 成员域（列表/状态/会话访问权）。邮件配置读侧已归拢到 mail-config.ts（#340）：
 * 本文件只 re-export 邮件装配判定，保住 settings 路由等既有 import 路径不断。
 */

/** 管理端成员列表的数据库行。 */
export interface Member {
  id: string;
  display_name: string | null;
  email: string | null;
  status: MemberStatus;
  role: string;
  created_at: string;
}

/** M1 成员生命周期仅在 active 与 disabled 之间翻转。 */
export type MemberStatus = 'active' | 'disabled';

/** 当前会话仍有访问权所需的最小用户真值。 */
export interface MemberAccess {
  role: string;
  status: MemberStatus;
}

/** 已配置 mail 段时按其内容构建 provisioner（#49 注入口）；实现住在 mail-config.ts（#340）。 */
export type { CreateMailProvisioner } from './mail-config';

/** 列出实例全部成员；M1 团队规模不分页。 */
export async function listMembers(db: D1Database): Promise<Member[]> {
  const result = await db
    .prepare('SELECT id, display_name, email, status, role, created_at FROM users')
    .all<Member>();
  return result.results;
}

/** 读取会话成员当前角色与状态，不信任 7 天 HMAC 会话内的旧权限。 */
export async function getMemberAccess(db: D1Database, userId: string): Promise<MemberAccess | null> {
  return db
    .prepare('SELECT role, status FROM users WHERE id = ?')
    .bind(userId)
    .first<MemberAccess>();
}

/** 更新成员状态并取回邮箱，以便完整实例联动可选 provisioner。 */
export async function setMemberStatus(
  db: D1Database,
  userId: string,
  status: MemberStatus,
): Promise<Pick<Member, 'id' | 'email' | 'status'> | null> {
  return db
    .prepare('UPDATE users SET status = ? WHERE id = ? RETURNING id, email, status')
    .bind(status, userId)
    .first<Pick<Member, 'id' | 'email' | 'status'>>();
}

/**
 * 邮件读侧与装配判定（#340 归拢）：实现全部住在 mail-config.ts（唯一事实源）。
 * 这里按既有 import 路径再导出装配/读侧判定——activate.ts / invites.ts（configuredMailProvisioner /
 * isMailEnabled）、routes/profile.ts（readMailAccess）的消费代码一行都不用动；
 * parseMailSection 是段解析内部件，settings.ts 已直连 mail-config，不经此处再导出。
 */
export {
  configuredMailProvisioner,
  isMailEnabled,
  readMailAccess,
} from './mail-config';
