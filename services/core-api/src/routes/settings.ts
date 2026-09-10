// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { audit } from '../services/audit';
import { readSession } from '../session';
import type { Bindings } from '../index';

/** 已配置密钥的固定占位符：GET 永不回传明文；PUT 见到它表示「保持不变」。 */
const MASK = '***';

/** oidc 字段 ↔ instance_config 扁平键（与 getOidcConfig/persistOidcConfig 一致）。 */
const OIDC_KEYS = {
  issuer: 'oidc_issuer',
  clientId: 'oidc_client_id',
  clientSecret: 'oidc_client_secret',
  scope: 'oidc_scope',
} as const;

/**
 * mail 段 JSON 字段（key='mail' 单条）：
 * stalwart-provisioner 消费 baseUrl/apiKey/domain，mail-smtp 消费 host/port/username/password/from。
 */
const MAIL_FIELDS = [
  'baseUrl',
  'apiKey',
  'domain',
  'host',
  'port',
  'username',
  'password',
  'from',
] as const;

type OidcField = keyof typeof OIDC_KEYS;

interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

interface MailSettings {
  baseUrl: string;
  apiKey: string;
  domain: string;
  host: string;
  port: number | '';
  username: string;
  password: string;
  from: string;
}

/** GET /api/admin/settings 的对外形状（两段齐备，缺省全空串）。 */
export interface InstanceSettings {
  oidc: OidcSettings;
  mail: MailSettings;
}

/** oidc 段宽松校验：未知键忽略，非法类型 400。 */
const oidcSchema = z.object({
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
});

/** mail 段宽松校验：port 只收正整数（空串表示不修改）。 */
const mailSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  domain: z.string().optional(),
  host: z.string().optional(),
  port: z.union([z.number().int().positive(), z.literal('')]).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  from: z.string().optional(),
});

const settingsSchema = z.object({
  oidc: oidcSchema.optional(),
  mail: mailSchema.optional(),
});

/** 普通文本字段：缺失/非字符串 → 空串（展示层统一字符串）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 敏感字段：已配置（非空）→ MASK；未配置（缺失/空串）→ 空串。 */
function masked(value: unknown): string {
  if (typeof value === 'string') return value.length > 0 ? MASK : '';
  return value === undefined || value === null ? '' : MASK;
}

/** port：正整数 → number；其余（含空/非法）→ 空串。 */
function portValue(value: unknown): number | '' {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  return '';
}

/** mail 段 JSON 必须是非数组对象；解析失败/类型不符 → {}（弱化实例不 500）。 */
function parseMailSection(raw: string | undefined): Record<string, unknown> {
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

/** UPSERT 语法与 persistOidcConfig/markSetupDone 一致。 */
async function upsertConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO instance_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(key, value)
    .run();
}

/** 读全表组装两段配置；密钥字段只回 MASK。 */
async function loadSettings(db: D1Database): Promise<InstanceSettings> {
  const rows = await db
    .prepare('SELECT key, value FROM instance_config')
    .all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((row) => [row.key, row.value]));
  const mail = parseMailSection(map.get('mail'));
  return {
    oidc: {
      issuer: text(map.get(OIDC_KEYS.issuer)),
      clientId: text(map.get(OIDC_KEYS.clientId)),
      clientSecret: masked(map.get(OIDC_KEYS.clientSecret)),
      scope: text(map.get(OIDC_KEYS.scope)),
    },
    mail: {
      baseUrl: text(mail.baseUrl),
      apiKey: masked(mail.apiKey),
      domain: text(mail.domain),
      host: text(mail.host),
      port: portValue(mail.port),
      username: text(mail.username),
      password: masked(mail.password),
      from: text(mail.from),
    },
  };
}

/** 落库：非空/非 MASK 字段才写；mail 段读-改-写合并，绝不覆盖已有真值。 */
async function saveSettings(
  c: Context<{ Bindings: Bindings }>,
  body: z.infer<typeof settingsSchema>,
): Promise<Response> {
  const db = c.env.CORE_DB;
  let wrote = false;

  for (const field of Object.keys(OIDC_KEYS) as OidcField[]) {
    const value = body.oidc?.[field];
    if (typeof value === 'string' && value.length > 0 && value !== MASK) {
      await upsertConfig(db, OIDC_KEYS[field], value);
      wrote = true;
    }
  }

  const existing = await db
    .prepare('SELECT value FROM instance_config WHERE key = ?')
    .bind('mail')
    .first<{ value: string }>();
  const mail = parseMailSection(existing?.value);
  let mailChanged = false;
  for (const field of MAIL_FIELDS) {
    const value = body.mail?.[field];
    if (field === 'port') {
      if (typeof value === 'number') {
        mail[field] = value;
        mailChanged = true;
      }
      continue;
    }
    if (typeof value === 'string' && value.length > 0 && value !== MASK) {
      mail[field] = value;
      mailChanged = true;
    }
  }
  // 整段合并后一次写回：只动本次传入的字段，其余键原样保留。
  if (mailChanged) {
    await upsertConfig(db, 'mail', JSON.stringify(mail));
    wrote = true;
  }

  // 幂等：全部空/*** → 不写库不写审计，仍回 ok。
  if (wrote) {
    await audit(db, (await readSession(c))!.uid, 'settings_updated');
  }
  return c.json({ ok: true });
}

/**
 * 挂载实例设置域（/api/admin/settings）。
 * 守卫由组合根统一挂载（requireAdmin）；此处只定义路由语义。
 */
export function registerSettingsRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /** 查看实例设置：OIDC 与 mail 两段；密钥字段脱敏。 */
  app.get('/api/admin/settings', async (c) => c.json(await loadSettings(c.env.CORE_DB)));

  /** 编辑实例设置：JSON body 部分字段合并；空/*** 字段跳过。 */
  app.put('/api/admin/settings', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = settingsSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json({ error: 'invalid settings', detail: z.prettifyError(parsed.error) }, 400);
    }
    return saveSettings(c, parsed.data);
  });
}
