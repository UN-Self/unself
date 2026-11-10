// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import { getSigningRuntime } from '../keys';
import { checkTokenGate, issueModuleToken, MODULE_TOKEN_ISSUER } from '../token';
import { ConnectRegisterSchema, connectPendingManifest, listMemberModules, listModules, ModuleRegistrationSchema, registryFrameOrigins, toggleModule, upsertModule } from '../registry';
import { audit } from '../services/audit';
import { configuredMailSender, deliverNotification } from '../services/notifications';
import { readSession } from '../session';
import { profileAvatarUrl } from '../services/avatar-store';
import { getProfileIdentity } from '../services/users';
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
  // #19：module_toggled 广播——全员 active 成员站内通知（渠道位由 notification_types 定，
  // module_toggled 只站内）；投递只依赖 db，邮件失败在通知域内落审计，不影响启停响应。
  await deliverNotification(
    c.env.CORE_DB,
    await configuredMailSender(c.env.CORE_DB),
    'module_toggled',
    { moduleId, enabled: body.enabled },
    { broadcast: true },
  );
  return c.json(result);
}

/** 挂载模块域（/api/modules/*、/api/admin/modules*）与公钥端点。 */
export function registerModuleRoutes(app: Hono<{ Bindings: Bindings }>): void {
  /**
   * 模块 token 签发（§5.2）：
   * 壳持有会话后为 iframe 模块取 token 的端点；aud=模块 id，10 分钟有效。
   * 门禁：登录态（会话有效 + 成员 status='active'）由组合根挂的会话守卫统一判定
   * （issue #187 唯一真值点，见 middleware/session-guard.ts）；此处只管模块存在且 enabled（注册表开关）。
   */
  app.post('/api/modules/:id/token', async (c) => {
    const secret = c.env.JWT_PRIVATE_KEY;
    if (!secret) {
      return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
    }
    const session = (await readSession(c))!;
    const moduleId = c.req.param('id');
    const gate = await checkTokenGate(c.env.CORE_DB, moduleId);
    if (!gate.ok) {
      return c.json({ error: gate.error ?? 'forbidden' }, (gate.status ?? 403) as 401 | 403 | 404);
    }
    const runtime = await getSigningRuntime(secret);
    if (!runtime) {
      return c.json({ error: 'signing key not provisioned (run deploy bootstrap)' }, 503);
    }
    const profile = await getProfileIdentity(c.env.CORE_DB, session.uid);
    const issued = await issueModuleToken(
      runtime,
      { userId: session.uid, moduleId, name: profile?.name ?? session.name, profileRevision: profile?.revision, avatarUrl: profile?.avatarKey == null ? undefined : profileAvatarUrl(c.req.url, profile.avatarKey) },
      { issuer: MODULE_TOKEN_ISSUER },
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

  /**
   * 卸载模块（#270 T6）：注册表移除 = token 失效。
   * 行删除后 checkTokenGate / checkModuleGate 对该 id 查无此行即 404——已签 token 虽未到期，
   * 但换发与模块 API 门禁都过不了注册表这一关，模块随即整体失联。
   * 幂等语义：未注册即无操作（404，不伪造成功）；引擎侧（control-plane）另管删 worker/路由/DROP 表。
   */
  app.delete('/api/admin/modules/:id', async (c) => {
    const moduleId = c.req.param('id');
    const result = await c.env.CORE_DB.prepare('DELETE FROM module_registry WHERE id = ?').bind(moduleId).run();
    if (!result.meta.changes) {
      return c.json({ error: 'module not found' }, 404);
    }
    await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_removed', moduleId);
    return c.json({ id: moduleId, removed: true });
  });

  /**
   * 反连接入：记账预注册（#349，决策 #108 两段式的第①段）。
   * 动线：用户在工作台「新增模块」选 connect 形态 → 浏览器本地 WebCrypto 生成 key、
   * 算 hex(SHA-256(key)) → 本端点记账；之后用户把 core 可达地址 + key 写进模块 env 部署，
   * 模块主动外连（dial-home）完成注册与保活 → 工作台「测试连接」绿 → 保存。
   * 保存 = 两段式的第②段：复用既有 POST /api/admin/modules upsert 激活（enabled=true）。
   *
   * 本端点语义 = upsert 一行 mode='connect' + credential_hash + entry=core 隧道路由的
   * pending 态（enabled=false）：
   * - 不携带 manifest（#349）：清单快照归保存段的 upsert；本段只负责「记账 + 发路由」。core
   *   侧 /m/<id>/ 路由分配由 T2（core 隧道面）承接，此处只写注册表。
   * - 幂等：同一 moduleId 重放（双击/重试）覆盖哈希，不建第二行（PK 硬闸）。
   * - keyHash 形状（64 位小写 hex，浏览器 hex(SHA-256(key))）由 CREDENTIAL_HASH_PATTERN 单点校验；
   *   明文 key 只在浏览器内存与一次性展示里，core 全程只见哈希（#102 措辞修订，决策 #108）。
   * - 权限：管理员会话（requireAdmin 由组合根 /api/admin/* 前缀统一挂）——接入是实例级管理动作。
   * - 落点列合并语义跟 0012/#348 review 定案：本段未写 entry/storage_level 时保留列中旧值
   *   （重复记账不冲掉用户已选存储）， credential_hash 显式传值覆盖（记账语义就是写哈希）。
   */
  app.post('/api/admin/modules/connect-register', async (c) => {
    const parsed = ConnectRegisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid connect registration', detail: z.prettifyError(parsed.error) }, 400);
    }
    const { moduleId, keyHash, storageLevel } = parsed.data;
    // core 分配路由（决策 #108）：反连模块的接入点 = core 自己的隧道路由 /m/<id>/，
    // 记账时刻即可知（请求 origin）。这也是 0012 CHECK（connect 必填 entry）的满足方式
    // ——记账段不放松数据层不变式， entry 指向的隧道面由 T2（core 隧道面）承接。
    const routeEntry = `${new URL(c.req.url).origin}/m/${moduleId}/`;
    // 两段式语义承载于此：pending 态（enabled=false），第②段保存时经既有 upsert 激活（enabled=true）。
    // manifest 用占位快照（真快照归保存段）；storage_level 未写保留旧值（合并语义，#348 review 定案）。
    // entry 每次显式写 core 路由（记账语义 = 把模块接回 core 隧道）。
    const entry = await upsertModule(c.env.CORE_DB, {
      id: moduleId,
      enabled: false,
      manifest: connectPendingManifest(moduleId, routeEntry),
      mode: 'connect',
      entry: routeEntry,
      credential_hash: keyHash,
      storage_level: storageLevel ?? null,
    });
    await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_connect_registered', moduleId);
    return c.json({ id: entry.id, mode: entry.mode, enabled: entry.enabled }, 201);
  });

  /** 全量列表（管理端，含停用）。 */
  app.get('/api/admin/modules', async (c) => {
    return c.json(await listModules(c.env.CORE_DB));
  });

  /**
   * 成员侧：仅启用模块的收窄面（#348 遗留收窄，#349）——不回落点三列与 credential_hash。
   * 每行回 id/enabled/name/manifest（壳 iframe 与 nav 图标的数据源）；
   * 完整条目走管理端 GET /api/admin/modules。
   */
  app.get('/api/modules', async (c) => {
    return c.json(await listMemberModules(c.env.CORE_DB));
  });

  /**
   * 外壳 frame-src 白名单（决策 #63/#73 动态 CSP）：启用模块 entry 的 origin 集合。
   * 壳启动时拉一次并重写 index.html 的 CSP；加模块只改注册表、不重建外壳。
   * 匿名可读与 /api/modules 同口径（origin 列表无敏感面；不暴露模块清单细节）。
   */
  app.get('/api/modules/frame-origins', async (c) => {
    const selfOrigin = new URL(c.req.url).origin;
    return c.json(await registryFrameOrigins(c.env.CORE_DB, { selfOrigin }));
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
