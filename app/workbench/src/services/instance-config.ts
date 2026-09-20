// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

import type { OidcClientConfig } from '../oidc';
import type { Bindings } from '../index';

/** setup 已完成标记（instance_config 键）。 */
export const SETUP_DONE_KEY = 'setup_done';

/** 当前请求的对外 origin（redirect_uri/callback 拼接用）。 */
function requestOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * 解析登录配置：生产读 instance_config 表（setup 向导写入）；开发可用环境变量兜底。
 * 表不存在（迁移未跑）→ 落到环境变量兜底；两者皆无 → null（登录/激活不可用）。
 */
export async function getOidcConfig(
  c: { env: Bindings; req: { url: string } },
): Promise<OidcClientConfig | null> {
  let issuer: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scope: string | undefined;
  try {
    const rows = await c.env.CORE_DB.prepare(
      'SELECT key, value FROM instance_config WHERE key IN (?, ?, ?, ?)',
    )
      .bind('oidc_issuer', 'oidc_client_id', 'oidc_client_secret', 'oidc_scope')
      .all<{ key: string; value: string }>();
    const map = new Map(rows.results.map((r) => [r.key, r.value]));
    issuer = map.get('oidc_issuer');
    clientId = map.get('oidc_client_id');
    clientSecret = map.get('oidc_client_secret');
    scope = map.get('oidc_scope');
  } catch {
    // 表不存在（迁移未跑）→ 落到环境变量兜底
  }
  issuer = issuer ?? c.env.OIDC_ISSUER;
  clientId = clientId ?? c.env.OIDC_CLIENT_ID;
  clientSecret = clientSecret ?? c.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) {
    return null; // 未配置：登录不可用（setup 流程尚未跑）
  }
  return {
    issuer,
    clientId,
    clientSecret,
    scope: scope ?? c.env.OIDC_SCOPE ?? 'openid profile email',
    redirectUri: `${requestOrigin(c.req.url)}/api/auth/callback`,
  };
}

/** instance_config 键与激活 body 字段的映射（与 getOidcConfig 读取键一致）。 */
const OIDC_CONFIG_KEYS = {
  issuer: 'oidc_issuer',
  clientId: 'oidc_client_id',
  clientSecret: 'oidc_client_secret',
  scope: 'oidc_scope',
} as const;

/** 激活 body 中合法 OIDC 字段的形状（非法/缺失 → 忽略该字段）。 */
const OIDC_FIELD_SCHEMAS = {
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scope: z.string().min(1),
} as const;

/**
 * 把向导录入的 OIDC 字段写入 instance_config（UPSERT，与 markSetupDone 同语法）。
 * 返回是否有字段落库（全部无效返回 false，调用方据此决定是否审计）。
 */
export async function persistOidcConfig(
  db: D1Database,
  body: Record<string, unknown> | null,
): Promise<boolean> {
  let stored = false;
  for (const field of Object.keys(OIDC_CONFIG_KEYS) as Array<keyof typeof OIDC_CONFIG_KEYS>) {
    const parsed = OIDC_FIELD_SCHEMAS[field].safeParse(body?.[field]);
    if (!parsed.success) continue;
    await db
      .prepare(
        'INSERT INTO instance_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')',
      )
      .bind(OIDC_CONFIG_KEYS[field], parsed.data)
      .run();
    stored = true;
  }
  return stored;
}

/** setup 是否已完成（已完成后整条 setup 链路永久封死，§5.2）。 */
export async function isSetupDone(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT value FROM instance_config WHERE key = ?')
    .bind(SETUP_DONE_KEY)
    .first<{ value: string }>();
  return row?.value === '1';
}

/** 标记 setup 完成（幂等：只在未完成时写）。 */
export async function markSetupDone(db: D1Database): Promise<void> {
  await db
    .prepare(
      'INSERT INTO instance_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')',
    )
    .bind(SETUP_DONE_KEY, '1')
    .run();
}
