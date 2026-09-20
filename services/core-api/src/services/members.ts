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
 * 装配引擎（packages/installer/src/engine）生成 Worker 入口经 createApp({ createMailProvisioner }) 注入 Stalwart 适配器，
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
 * mail 段 JSON 必须是非数组对象；解析失败/类型不符 → {}（弱化实例不 500）。
 * 唯一副本：settings 路由（读写合并）与能力判定（isMailEnabled/configuredMailProvisioner）共用，
 * 别处不得再写同语义解析（一职责一处）。
 */
export function parseMailSection(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
 * mail 段里的邮件门户地址（#168 应用密码说明页的跳转目标）：
 * portalUrl 优先；缺省用 domain 推导 https://mail.<domain>；
 * 两者都缺/非字符串/空串 → null（说明页仍给步骤，只是跳转按钮禁用）。
 */
function mailPortalUrl(section: Record<string, unknown>): string | null {
  const portalUrl = typeof section.portalUrl === 'string' ? section.portalUrl.trim() : '';
  if (portalUrl.length > 0) return portalUrl;
  const domain = typeof section.domain === 'string' ? section.domain.trim() : '';
  return domain.length > 0 ? `https://mail.${domain}` : null;
}

/**
 * 成员可见的邮件摘要（#168，/api/me 用）：一次读 mail 段。
 * enabled 与 isMailEnabled 同口径（唯一实现，见下）；
 * portalUrl 只在轴开时给——轴关时无门户可去，避免说明页给出误导链接。
 */
export async function readMailAccess(
  db: D1Database,
): Promise<{ enabled: boolean; portalUrl: string | null }> {
  const row = await readMailSegment(db);
  const section = parseMailSection(row?.value);
  const enabled = row !== null && section.enabled !== false;
  return { enabled, portalUrl: enabled ? mailPortalUrl(section) : null };
}

/**
 * 实例邮件轴能力开关（#149，邮件轴开关后含 enabled 轴）：
 * mail 行存在且 enabled !== false = 完整实例（开户/激活链接）；
 * 无行或 enabled === false = 弱化实例（批准即激活，表单不采集邮箱）。
 * 解析失败/缺 enabled 字段的老数据 → true（生产零迁移兼容）。
 */
export async function isMailEnabled(db: D1Database): Promise<boolean> {
  return (await readMailAccess(db)).enabled;
}

/**
 * 配置有 mail 段且未被开关关闭（enabled !== false）才惰性构建 provisioner；
 * 无段或 enabled === false 即弱化实例（null，静默降级——批准仍走「批准即激活」，不开户）。
 * 生产走 defaultCreateMailProvisioner；单测在外部边界注入假实现（#20 fake，routing 断言用）。
 */
export async function configuredMailProvisioner(
  db: D1Database,
  createMailProvisioner: CreateMailProvisioner = defaultCreateMailProvisioner,
): Promise<MailProvisioner | null> {
  const config = await readMailSegment(db);
  if (!config || parseMailSection(config.value).enabled === false) {
    return null;
  }
  return createMailProvisioner(JSON.parse(config.value));
}
