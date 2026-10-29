// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 实例设置域路由（#340 分域）：OIDC 登录 / 邮箱管理（Stalwart 开户）/ 通知发信（SMTP）
 * 三段各自独立 GET/PUT。instance_config 的存储键：
 * - OIDC：四个扁平键 oidc_issuer / oidc_client_id / oidc_client_secret / oidc_scope；
 * - 邮箱管理：mail_stalwart 单键 JSON（enabled + baseUrl/apiKey/domain/portalUrl）；
 * - 通知发信：mail_smtp 单键 JSON（enabled + host/port/username/password/from）。
 *
 * 密钥铁律：GET 恒回 '***'（已配置）或 ''（未配置），明文不进任何响应；
 * PUT 密钥传 '***'、空串或缺键 = 保持库中现值（密钥无清空入口）；
 * 普通文本字段传空串 = 清空该字段（删键，决策 #100；portalUrl 先 trim，纯空白也删）；
 * 审计只记动作与 target，不含字段值。
 *
 * D5 fail-closed：mail 两段 PUT 的 enabled 必填且恒布尔（缺 → 400）；enabled:true 时
 * 必填字段不全（新值或库里已有都算已配）→ 400 拒绝落库。读侧装配只认 enabled === true
 * （mail-config.ts 单点判定），这里只管写侧的形状与硬校验。
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { audit } from '../services/audit';
import { parseMailSection, readSmtpSection, readStalwartSection } from '../services/mail-config';
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

type OidcField = keyof typeof OIDC_KEYS;

interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** GET 的邮箱管理段：enabled 恒布尔；密钥只回 MASK。 */
interface StalwartSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  domain: string;
  /** 邮件门户地址（#184）：缺省空串，成员说明页回退用 domain 推导。 */
  portalUrl: string;
}

/** GET 的通知发信段：port 正整数或 ''（未配置）；密钥只回 MASK。 */
interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number | '';
  username: string;
  password: string;
  from: string;
}

/** GET /api/admin/settings 的对外形状（三段齐备，缺省全空串 + enabled:false）。 */
export interface InstanceSettings {
  oidc: OidcSettings;
  stalwart: StalwartSettings;
  smtp: SmtpSettings;
}

/** oidc 段宽松校验：未知键忽略，非法类型 400。 */
const oidcSchema = z.object({
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
});

/** mail_stalwart 段校验：enabled 必填恒布尔（D5，缺 → 400）；其余字段可选走合并语义。 */
const stalwartSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  domain: z.string().optional(),
  portalUrl: z.string().optional(),
});

/** mail_smtp 段校验：同上；port 收正整数或空串（空串 = 删键，#100）。 */
const smtpSchema = z.object({
  enabled: z.boolean(),
  host: z.string().optional(),
  port: z.union([z.number().int().positive(), z.literal('')]).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  from: z.string().optional(),
});

/**
 * PUT /api/admin/settings 只收 { oidc? }：历史 body 夹带的 mail/stalwart/smtp 键
 * 直接忽略（zod strip 默认行为，不额外报错，保持宽松校验惯例）。
 */
const settingsSchema = z.object({
  oidc: oidcSchema.optional(),
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

/** UPSERT 语法与 persistOidcConfig/markSetupDone 一致。 */
async function upsertConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO instance_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(key, value)
    .run();
}

/** 读全表组装三段配置；密钥字段只回 MASK；无行/损坏段 enabled:false、其余空串。 */
async function loadSettings(db: D1Database): Promise<InstanceSettings> {
  const rows = await db
    .prepare('SELECT key, value FROM instance_config')
    .all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((row) => [row.key, row.value]));
  const stalwart = parseMailSection(map.get('mail_stalwart'));
  const smtp = parseMailSection(map.get('mail_smtp'));
  return {
    oidc: {
      issuer: text(map.get(OIDC_KEYS.issuer)),
      clientId: text(map.get(OIDC_KEYS.clientId)),
      clientSecret: masked(map.get(OIDC_KEYS.clientSecret)),
      scope: text(map.get(OIDC_KEYS.scope)),
    },
    stalwart: {
      enabled: stalwart.enabled === true,
      baseUrl: text(stalwart.baseUrl),
      apiKey: masked(stalwart.apiKey),
      domain: text(stalwart.domain),
      portalUrl: text(stalwart.portalUrl),
    },
    smtp: {
      enabled: smtp.enabled === true,
      host: text(smtp.host),
      port: portValue(smtp.port),
      username: text(smtp.username),
      password: masked(smtp.password),
      from: text(smtp.from),
    },
  };
}

// 段读取统一走 mail-config.ts 的单点 helper（一文件一职责：同语义 SQL 只此一处）。

/**
 * 邮件两段字段合并（决策 #100）。缺键 = 保持（值 undefined 的键直接跳过）。
 * 按字段类别分级，同一字段只落一类：
 * - sensitive（apiKey / password）：只写不读——仅非空、非 MASK 且与库值不同才覆盖；
 *   空串 / MASK 一律保持（没有清空入口）。
 * - numeric（port）：正整数覆盖；空串删键；其它类型原样忽略（schema 已挡，这里不兜底报错）。
 * - clearable（portalUrl）：先 trim，非空覆盖、空白删键（读侧回落按域名推导，#184）。
 * - 其余文本：非空覆盖（不 trim，纯空白仍算非空），空串删键。
 * 值与库中相同不算变化；返回是否有字段变化（不含 enabled）。
 */
function applyFieldMerges(
  section: Record<string, unknown>,
  input: Record<string, unknown>,
  opts: { clearable?: string; numeric?: string; sensitive?: readonly string[] } = {},
): boolean {
  const sensitive = opts.sensitive ?? [];
  let changed = false;
  for (const [field, value] of Object.entries(input)) {
    if (field === 'enabled' || value === undefined) continue;
    if (sensitive.includes(field)) {
      if (typeof value === 'string' && value.length > 0 && value !== MASK && value !== section[field]) {
        section[field] = value;
        changed = true;
      }
      continue;
    }
    if (field === opts.numeric) {
      if (typeof value === 'number') {
        if (section[field] !== value) {
          section[field] = value;
          changed = true;
        }
      } else if (value === '' && field in section) {
        delete section[field];
        changed = true;
      }
      continue;
    }
    if (typeof value !== 'string') continue;
    if (field === opts.clearable) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (section[field] !== trimmed) {
          section[field] = trimmed;
          changed = true;
        }
      } else if (field in section) {
        delete section[field];
        changed = true;
      }
      continue;
    }
    if (value.length > 0) {
      if (section[field] !== value) {
        section[field] = value;
        changed = true;
      }
      continue;
    }
    if (field in section) {
      delete section[field];
      changed = true;
    }
  }
  return changed;
}

/**
 * D5 必填核对：文本字段非空串（trim 后）才算已配；数值字段（port）正整数才算已配。
 * 缺 → 400 拒落库。
 */
function missingRequired(
  section: Record<string, unknown>,
  required: readonly string[],
  numeric: readonly string[],
): string[] {
  return required.filter((field) => {
    const value = section[field];
    // 字段类型由规格声明（不是按当前值猜）：脏数据里 baseUrl:123 不能被当成「已配」放行
    if (numeric.includes(field)) {
      return !(typeof value === 'number' && Number.isInteger(value) && value > 0);
    }
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

/** mail 分域 PUT 的路由规格：存储键、审计 target、段读取 helper、D5 必填与人话清单。 */
interface MailRouteSpec {
  key: 'mail_stalwart' | 'mail_smtp';
  target: 'mail-stalwart' | 'mail-smtp';
  /** 段读取（mail-config.ts 单点实现；缺行/损坏 → 空对象）。 */
  read: (db: D1Database) => Promise<Record<string, unknown>>;
  required: readonly string[];
  /** required 里哪些是「正整数」字段（其余按非空字符串判）。 */
  numeric: readonly string[];
  /** 只写不读的密钥字段（无清空入口）。 */
  sensitive: readonly string[];
  labels: Record<string, string>;
  detailPrefix: string;
}

const STALWART_SPEC: MailRouteSpec = {
  key: 'mail_stalwart',
  target: 'mail-stalwart',
  read: readStalwartSection,
  required: ['baseUrl', 'apiKey', 'domain'],
  numeric: [],
  sensitive: ['apiKey'],
  labels: { baseUrl: 'Stalwart 地址', apiKey: 'API Key', domain: '邮箱域名' },
  detailPrefix: '开启邮箱管理需先配置：',
};

const SMTP_SPEC: MailRouteSpec = {
  key: 'mail_smtp',
  target: 'mail-smtp',
  read: readSmtpSection,
  required: ['host', 'port', 'username', 'password', 'from'],
  numeric: ['port'],
  sensitive: ['password'],
  labels: { host: 'SMTP host', port: 'port', username: '用户名', password: '密码', from: '发件地址' },
  detailPrefix: '开启通知发信需先配置：',
};

/**
 * mail 分域 PUT 主体：整键读-改-写，只碰本键（另一个 mail 键零接触，互不产生）。
 * 顺序：内存合并（applyFieldMerges，#100）→ D5 核对（enabled:true 且合并后必填不全 → 400，
 * 此时整段不落库，清空也无半途生效）→ 落库 + 审计。
 * enabled:false 半配置可落库（关着不算启用）。幂等：无变化不写库不写审计。
 * #99 空保存：段本就不存在 + 只要求关闭 + 无字段变化 = 默认状态，幂等空操作不建段
 * （缺行的 enabled 按 D5 同口径视为 false，否则会被判成 enabled 变化而凭空建行）。
 */
async function saveMailSection(
  c: Context<{ Bindings: Bindings }>,
  spec: MailRouteSpec,
  body: Record<string, unknown>,
): Promise<Response> {
  const db = c.env.CORE_DB;
  const section = await spec.read(db);
  const noExistingSection = Object.keys(section).length === 0;
  const fieldsChanged = applyFieldMerges(section, body, {
    clearable: 'portalUrl',
    numeric: 'port',
    sensitive: spec.sensitive,
  });

  if (noExistingSection && !fieldsChanged && body.enabled === false) {
    return c.json({ ok: true });
  }

  const enabledChanged = section.enabled !== body.enabled;

  if (body.enabled === true) {
    const missing = missingRequired(section, spec.required, spec.numeric);
    if (missing.length > 0) {
      return c.json(
        {
          error: 'invalid settings',
          detail: `${spec.detailPrefix}${missing.map((field) => spec.labels[field] ?? field).join('、')}`,
        },
        400,
      );
    }
  }
  section.enabled = body.enabled;

  if (!fieldsChanged && !enabledChanged) {
    return c.json({ ok: true });
  }
  await upsertConfig(db, spec.key, JSON.stringify(section));
  await audit(db, (await readSession(c))!.uid, 'settings_updated', spec.target);
  return c.json({ ok: true });
}

/** OIDC PUT 主体：只碰 oidc 四个扁平键；空/*** 字段跳过；幂等不写审计。 */
async function saveOidcSettings(
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
  if (wrote) {
    await audit(db, (await readSession(c))!.uid, 'settings_updated', 'oidc');
  }
  return c.json({ ok: true });
}

/**
 * JSON body 解析 + schema 校验。失败直接返回 400 响应（调用方 instanceof Response 判定后原样
 * 回传——不能经 c.res 兜底：未设响应时 c.res 是默认 200，会吃掉 400）。
 */
async function parseBody<T>(c: Context<{ Bindings: Bindings }>, schema: z.ZodType<T>): Promise<T | Response> {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid settings', detail: z.prettifyError(parsed.error) }, 400);
  }
  return parsed.data;
}

/**
 * 挂载实例设置域（/api/admin/settings）。
 * 守卫由组合根统一挂载（requireAdmin）；此处只定义路由语义。
 */
export function registerSettingsRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /** 查看实例设置：OIDC / 邮箱管理 / 通知发信三段；密钥字段脱敏。 */
  app.get('/api/admin/settings', async (c) => c.json(await loadSettings(c.env.CORE_DB)));

  /** 编辑 OIDC 登录设置：只收 { oidc? }，多余键忽略；空/*** 字段跳过。 */
  app.put('/api/admin/settings', async (c) => {
    const body = await parseBody(c, settingsSchema);
    if (body instanceof Response) return body;
    return saveOidcSettings(c, body);
  });

  /** 编辑邮箱管理（Stalwart 开户）段：整键读-改-写，D5 硬校验。 */
  app.put('/api/admin/settings/mail-stalwart', async (c) => {
    const body = await parseBody(c, stalwartSchema);
    if (body instanceof Response) return body;
    return saveMailSection(c, STALWART_SPEC, body);
  });

  /** 编辑通知发信（SMTP）段：整键读-改-写，D5 硬校验。 */
  app.put('/api/admin/settings/mail-smtp', async (c) => {
    const body = await parseBody(c, smtpSchema);
    if (body instanceof Response) return body;
    return saveMailSection(c, SMTP_SPEC, body);
  });
}
