// SPDX-License-Identifier: AGPL-3.0-only
import type { MailProvisioner } from '@unself/contracts';
import {
  createStalwartMailProvisioner,
  type StalwartProvisionerConfig,
} from '@unself/stalwart-provisioner';

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

/** 已配置 mail 段时按其内容构建 provisioner（#49 注入口）。 */
export type CreateMailProvisioner = (mailConfig: unknown) => MailProvisioner;

/** 生产唯一实现：mail 段 → Stalwart JMAP 适配器（#18 接线，不留第二道 DI）。 */
const defaultCreateMailProvisioner: CreateMailProvisioner = (mailConfig) =>
  createStalwartMailProvisioner(mailConfig as StalwartProvisionerConfig);

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
 * 配置有 mail 段才惰性构建 provisioner；无段即弱化实例（null，静默降级）。
 * 生产走 defaultCreateMailProvisioner；单测在外部边界注入假实现（#20 fake，routing 断言用）。
 */
export async function configuredMailProvisioner(
  db: D1Database,
  createMailProvisioner: CreateMailProvisioner = defaultCreateMailProvisioner,
): Promise<MailProvisioner | null> {
  const config = await db
    .prepare('SELECT value FROM instance_config WHERE key = ?')
    .bind('mail')
    .first<{ value: string }>();
  if (!config) {
    return null;
  }
  return createMailProvisioner(JSON.parse(config.value));
}
