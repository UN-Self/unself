// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import { getSigningRuntime } from '../keys';
import {
  capsFromManifest,
  checkTokenGate,
  issueModuleToken,
  MODULE_TOKEN_ISSUER,
} from '../token';
import {
  listModules,
  ModuleRegistrationSchema,
  toggleModule,
  upsertModule,
} from '../registry';
import { audit } from '../services/audit';
import { getMemberAccess } from '../services/members';
import { readSession } from '../session';
import type { Bindings } from '../index';

/**
 * 启停公共处理（PATCH /enabled 遗留端点与 POST /toggle 归属端点共用同一语义，§5.5）：
 * body { enabled: boolean } → 注册表翻转 → 审计（module_enabled/module_disabled）。
 */
async function handleModuleToggle(
  c: Context<{ Bindings: Bindings }>,
  moduleId: string,
): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') {
    return c.json({ error: 'body must be { enabled: boolean }' }, 400);
  }
  const result = await toggleModule(c.env.CORE_DB, moduleId, body.enabled);
  if (!result) {
    return c.json({ error: 'module not found' }, 404);
  }
  await audit(
    c.env.CORE_DB,
    (await readSession(c))!.uid,
    body.enabled ? 'module_enabled' : 'module_disabled',
    moduleId,
  );
  // TODO(#19): module_toggled 通知占位——通知域接线后在此触发（收件人/载荷由 #19 定）。
  return c.json(result);
}

/** 挂载模块域（/api/modules/*、/api/admin/modules*）与公钥端点。 */
export function registerModuleRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /**
   * 模块 token 签发（§5.2）：
   * 壳持有会话后为 iframe 模块取 token 的端点；aud=模块 id，10 分钟有效。
   * 门禁：会话必须有效；模块必须存在且 enabled（注册表开关）。
   */
  app.post('/api/modules/:id/token', async (c) => {
    const secret = c.env.JWT_PRIVATE_KEY;
    if (!secret) {
      return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
    }
    const session = await readSession(c);
    if (!session) {
      return c.json({ error: 'authentication required' }, 401);
    }
    const member = await getMemberAccess(c.env.CORE_DB, session.uid);
    if (member?.status === 'disabled') {
      return c.json({ error: 'account disabled' }, 403);
    }
    const moduleId = c.req.param('id');
    const gate = await checkTokenGate(c.env.CORE_DB, moduleId);
    if (!gate.ok) {
      return c.json({ error: gate.error ?? 'forbidden' }, (gate.status ?? 403) as 401 | 403 | 404);
    }
    const runtime = await getSigningRuntime(secret);
    if (!runtime) {
      return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
    }
    const issued = await issueModuleToken(
      runtime,
      { userId: session.uid, moduleId, name: session.name },
      { issuer: MODULE_TOKEN_ISSUER, caps: capsFromManifest(gate.manifest!.manifest_json) },
    );
    return c.json(issued);
  });

  /** 注册/更新模块（deploy 脚本装配时调用；manifest 快照随注册刷新）。 */
  app.post('/api/admin/modules', async (c) => {
    const parsed = ModuleRegistrationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid registration', detail: z.prettifyError(parsed.error) }, 400);
    }
    const entry = await upsertModule(c.env.CORE_DB, parsed.data);
    await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_upserted', parsed.data.id);
    return c.json(entry, 201);
  });

  /** 翻转启停（#7 遗留端点，行为不变）：运行时秒级生效（边栏隐藏 + token 门禁拒发，§5.5）。 */
  app.patch('/api/admin/modules/:id/enabled', (c) => handleModuleToggle(c, c.req.param('id')));

  /** 模块启停写端点（#49 归属切分；#17 管理界面消费）：与 PATCH 同语义，二选一即可。 */
  app.post('/api/admin/modules/:id/toggle', (c) => handleModuleToggle(c, c.req.param('id')));

  /** 全量列表（管理端，含停用）。 */
  app.get('/api/admin/modules', async (c) => {
    return c.json(await listModules(c.env.CORE_DB));
  });

  /** 成员侧：仅启用模块（边栏/nav 数据源，#12 消费）。 */
  app.get('/api/modules', async (c) => {
    const all = await listModules(c.env.CORE_DB);
    return c.json(all.filter((m) => m.enabled));
  });

  /** 实例公钥集：模块后端与 SDK 验签的唯一真值来源（§5.2）。 */
  app.get('/.well-known/jwks.json', async (c) => {
    const runtime = await getSigningRuntime(c.env?.JWT_PRIVATE_KEY);
    if (!runtime) {
      return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
    }
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(runtime.jwks);
  });
}
