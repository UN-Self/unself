// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 邮件配置读侧唯一事实源（#340）：instance_config 的 `mail_stalwart`（开户）与
 * `mail_smtp`（发信）两个独立键的读取、解析与装配全在此文件。
 *
 * 口径（#340 已定决策）：
 * - 旧 `mail` 键是 0010 及之前的历史遗存，0011 迁移已拆键；本文件零读取旧键
 *   （D2 回滚兼容：旧行保留在库，但任何读路径都不再碰它）。
 * - `enabled` 恒为显式布尔，缺省关（D5 fail-closed，反转旧 `!== false` 的缺省开）。
 *   段落存在即意味着 0011/设置路由已写入完整字段，装配口不再查字段完整性；
 *   残缺段（手工改库/回滚遗留）由防御读取兜底：不装配、不抛错。
 * - 解析语义照搬原 members.ts 的 parseMailSection（唯一副本迁到这里）：
 *   非 null 原型的非数组对象才通过，损坏/类型不符 → {}（弱化实例不 500）。
 */
import type { MailProvisioner } from '@unself/contracts';
import { createFakeMailProvisioner } from '@unself/contracts';
import { createMailSenderFromConfig, type MailSender } from '@unself/mail-smtp';

/** Stalwart 段（开户轴）解析形状：settings 路由写侧与 0011 迁移共同保证字段完整。 */
export interface StalwartSection {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  domain: string;
  portalUrl?: string;
}

/** SMTP 段（发信轴）解析形状：settings 路由写侧与 0011 迁移共同保证字段完整。 */
export interface SmtpSection {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
}

/** 已配置 mail 段时按其内容构建 provisioner（#49 注入口）。 */
export type CreateMailProvisioner = (mailConfig: unknown) => MailProvisioner;

/** SMTP 装配注入面（#18 测试口）：外部边界替身只在此层；缺省 = 真 SMTP。 */
export type CreateMailSender = (mailConfig: Record<string, unknown>) => MailSender | null;

/**
 * 生产组合根装配点（#141 分层归位后）：core-api 服务域只认 contracts 契约。
 * 默认装配 = contracts 内存假实现（无网络副作用，测试/本地便利）；【生产入口必须注入真实现】：
 * 装配引擎（app/installer/src/engine）生成 Worker 入口经 createApp({ createMailProvisioner }) 注入 Stalwart 适配器，
 * 未注入的生产部署开户/改密只入内存不生效——这是显式回退，不是弱化实例口径。
 */
const defaultCreateMailProvisioner: CreateMailProvisioner = () => createFakeMailProvisioner();

/**
 * 配置段 JSON 必须是非数组对象；解析失败/类型不符 → {}（弱化实例不 500）。
 * 唯一副本：读侧（readStalwartSection/readSmtpSection）与 settings 路由（#340 起经本文件 import）共用，
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

/** 单点读取指定配置键原文（只取 value，不解析）。 */
async function readConfigValue(db: D1Database, key: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT value FROM instance_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value;
}

/**
 * 单点读取 instance_config 的 mail_stalwart 段（开户轴）。
 * 能力判定唯一真相源：configuredMailProvisioner 与 readMailAccess 共用本 helper，
 * 别处不得重写同语义 SQL（一文件一职责：stalwart 段读取只此一处）。
 */
export async function readStalwartSection(db: D1Database): Promise<Record<string, unknown>> {
  return parseMailSection(await readConfigValue(db, 'mail_stalwart'));
}

/**
 * 单点读取 instance_config 的 mail_smtp 段（发信轴）。
 * configuredMailSender 共用本 helper，别处不得重写同语义 SQL。
 */
export async function readSmtpSection(db: D1Database): Promise<Record<string, unknown>> {
  return parseMailSection(await readConfigValue(db, 'mail_smtp'));
}

/**
 * 段里的邮件门户地址（#168 应用密码说明页的跳转目标）：
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
 * 成员可见的邮件摘要（#168，/api/me 用）：一次读 mail_stalwart 段。
 * enabled 只认显式 true（D5 fail-closed）；portalUrl 只在轴开时给——
 * 轴关时无门户可去，避免说明页给出误导链接。对外形状 { enabled, portalUrl } 不变。
 */
export async function readMailAccess(
  db: D1Database,
): Promise<{ enabled: boolean; portalUrl: string | null }> {
  const section = await readStalwartSection(db);
  const enabled = section.enabled === true;
  return { enabled, portalUrl: enabled ? mailPortalUrl(section) : null };
}

/**
 * 实例邮件轴能力开关（#149，开户轴）：mail_stalwart 行 enabled === true = 完整实例
 * （开户/激活链接）；无行或 enabled !== true = 弱化实例（批准即激活，表单不采集邮箱）。
 * 防御读取：残缺段（enabled 缺失/非布尔）一律视为关，不抛错。
 */
export async function isMailEnabled(db: D1Database): Promise<boolean> {
  return (await readMailAccess(db)).enabled;
}

/**
 * mail_stalwart 段 enabled === true（#340 起 fail-closed）才惰性构建 provisioner；
 * 无段/enabled 非 true 即弱化实例（null，静默降级——批准仍走「批准即激活」，不开户）。
 * 不查字段完整性（D5：0011 迁移 + 设置路由硬校验保证）；残缺但 enabled:true 的段
 * 仍直接构造工厂（防御读取的兜底语义，工厂自身校验并抛结构化失败，装配口不吞）。
 * 生产走 defaultCreateMailProvisioner；单测在外部边界注入假实现（#20 fake，routing 断言用）。
 */
export async function configuredMailProvisioner(
  db: D1Database,
  createMailProvisioner: CreateMailProvisioner = defaultCreateMailProvisioner,
): Promise<MailProvisioner | null> {
  const section = await readStalwartSection(db);
  if (section.enabled !== true) {
    return null;
  }
  return createMailProvisioner(section);
}

/**
 * mail_smtp 段 enabled === true 才装配发信口：无段/enabled 非 true → null
 * （弱化实例静默降级）。#167 起开关轴与 isMailEnabled/configuredMailProvisioner
 * 同口径：关闭即不装配 sender，也不碰工厂。不查字段完整性（D5 保证）；
 * 残缺但 enabled:true 的段由 createMailSenderFromConfig 判定并回 null。
 */
export async function configuredMailSender(
  db: D1Database,
  createMailSender: CreateMailSender = createMailSenderFromConfig,
): Promise<MailSender | null> {
  const section = await readSmtpSection(db);
  if (section.enabled !== true) {
    return null;
  }
  return createMailSender(section);
}
