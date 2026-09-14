// SPDX-License-Identifier: AGPL-3.0-only
import type { MailProvisioner } from '@unself/contracts';
import { createFakeMailProvisioner } from '@unself/contracts';

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

/**
 * 生产组合根装配点（#141 分层归位后）：core-api 服务域只认 contracts 契约。
 * 默认装配 = contracts 内存假实现（无网络副作用，测试/本地便利）；【生产入口必须注入真实现】：
 * deploy/cloudflare 生成 Worker 入口经 createApp({ createMailProvisioner }) 注入 Stalwart 适配器，
 * 未注入的生产部署开户/改密只入内存不生效——这是显式回退，不是弱化实例口径。
 */
const defaultCreateMailProvisioner: CreateMailProvisioner = () => createFakeMailProvisioner();

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
 * 单点读取 instance_config 的 mail 段（只判有无/取原文，不解析）。
 * 能力判定唯一真相源（#149）：isMailEnabled 与 configuredMailProvisioner 共用本 helper，
 * 别处不得重写同语义 SQL（一文件一职责：mail 段读取只此一处）。
 */
async function readMailSegment(db: D1Database): Promise<{ value: string } | null> {
  return db
    .prepare('SELECT value FROM instance_config WHERE key = ?')
    .bind('mail')
    .first<{ value: string }>();
}

/**
 * 实例邮件轴能力开关：mail 段有无 = 邮件轴能力开关（#149）。
 * 有段=完整实例（开户/激活链接），无段=弱化实例（批准即激活，表单不采集邮箱）。
 */
export async function isMailEnabled(db: D1Database): Promise<boolean> {
  return (await readMailSegment(db)) !== null;
}

/**
 * 配置有 mail 段才惰性构建 provisioner；无段即弱化实例（null，静默降级）。
 * 生产走 defaultCreateMailProvisioner；单测在外部边界注入假实现（#20 fake，routing 断言用）。
 */
export async function configuredMailProvisioner(
  db: D1Database,
  createMailProvisioner: CreateMailProvisioner = defaultCreateMailProvisioner,
): Promise<MailProvisioner | null> {
  const config = await readMailSegment(db);
  if (!config) {
    return null;
  }
  return createMailProvisioner(JSON.parse(config.value));
}
