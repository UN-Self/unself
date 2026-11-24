// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import { getSigningRuntime } from '../keys';
import { checkTokenGate, issueModuleToken, MODULE_TOKEN_ISSUER } from '../token';
import { ConnectRegisterSchema, connectPendingManifest, getModuleConfig, listMemberModules, listModules, ModuleRegistrationSchema, registerPendingConnectModule, registryFrameOrigins, saveModuleConfig, toggleModule, upsertModule } from '../registry';
import { audit } from '../services/audit';
import { CONFIG_SECRET_MASK, ConfigValidationError, validateModuleConfigValues } from '../services/module-config';
import { installNpmModule, RuntimeInstallError, wipeCredential } from '../services/runtime-install';
import {
  accountWorkersDevSubdomain,
  CfRoutingError,
  enableWorkerWorkersDev,
  ensureWorkerRoute,
  findZoneForDomain,
  listAccountZones,
  mountEntryUrl,
  type ModuleMount,
} from '../services/cf-routing';
import { moduleRoutePattern, type ModuleManifest } from '@unself/contracts';
import { configuredMailSender, deliverNotification } from '../services/notifications';
import { STORAGE_LEVELS } from '@unself/control-plane/types';

/**
 * 运行时装配入参（#349 模式一 + #369 挂载选择）：npm 规格 + 会话内 CF 凭证 + 账号维度 + 挂载。
 * `cfToken` 不进任何持久面（#165）；`accountId` 是 CF 的资源定位，不是凭证。
 *
 * `mount` 三种（都是 direct 接入，区别只在 moduleId/entry 怎么来、要不要碰 CF）：
 * - zone：npm 包上传 worker + 建 zone 路由 `<domain>/m/<id>/*` → entry=`https://<domain>/m/<id>/`；
 * - workers-dev：npm 包上传 + 开通脚本子域 → entry=`https://<script>.<accountSubdomain>.workers.dev/`；
 * - existing（#369 用户定案）：管理员自己已经部署好了（不一定发到 npm），只给「模块 id + 模块地址」
 *   登记一行，不读包、不碰 CF；清单停在占位（见 install 端点注释里的已知缺口）。
 * 前两种要 npmSpec + cfToken + accountId（superRefine 兜底），existing 三个都不用。
 */
export const InstallMountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zone'), domain: z.string().trim().min(1).max(253) }),
  z.object({ kind: z.literal('workers-dev') }),
  z.object({
    kind: z.literal('existing'),
    /** 注册表主键由管理员直接声明（与 ConnectRegisterSchema 的 moduleId 同一形状）。 */
    moduleId: z.string().regex(/^[a-z][a-z0-9-]+$/),
    /** 地址校验沿用 ModuleRegistrationSchema 的 entry 规则（https 强制，localhost 明文豁免）。 */
    entry: z.string().trim().min(1).max(2048),
  }),
]);

export const InstallRequestSchema = z
  .object({
    npmSpec: z.string().min(1).max(200).optional(),
    cfToken: z.string().min(1).max(200).optional(),
    accountId: z.string().min(1).max(64).optional(),
    scriptName: z.string().regex(/^[a-z][a-z0-9-]*$/).max(63).optional(),
    storageLevel: z.enum(STORAGE_LEVELS).nullish(),
    mount: InstallMountSchema,
  })
  .superRefine((input, ctx) => {
    if (input.mount.kind === 'existing') return;
    if (!input.npmSpec) {
      ctx.addIssue({ code: 'custom', path: ['npmSpec'], message: '上传需要一个 npm 包规格' });
    }
    if (!input.cfToken) {
      ctx.addIssue({ code: 'custom', path: ['cfToken'], message: '上传/建路由需要 CF API Token' });
    }
    if (!input.accountId) {
      ctx.addIssue({ code: 'custom', path: ['accountId'], message: '上传/建路由需要 Cloudflare 账号 ID' });
    }
  });
import { readSession } from '../session';
import { profileAvatarUrl } from '../services/avatar-store';
import { getProfileIdentity } from '../services/users';
import type { Bindings } from '../index';

type InstallInput = z.infer<typeof InstallRequestSchema>;

interface MountedInstall {
  manifest: ModuleManifest;
  /** 上传后的 worker 名；existing 不上传，没有脚本（null）。 */
  scriptName: string | null;
  /** 注册表 entry：三种挂载都给出（direct 必须有对外地址，只是地址怎么来不同）。 */
  entry: string;
}

/**
 * 挂载执行：existing 既不读包也不碰 CF（只登记管理员给的 id 与地址，清单落占位）；
 * 另两种先上传脚本，再按形态建 zone 路由或开 workers.dev 子域。
 * 这里只做 CF 副作用与 URL 计算，注册表写入归调用方的 upsertModule（单一写入口）。
 */
async function installWithMount(input: InstallInput, mount: ModuleMount): Promise<MountedInstall> {
  if (mount.kind === 'existing') {
    return {
      // 占位清单：管理员自己部署的 worker 不会自报清单（无接入码，走不了 connect-manifest）
      manifest: connectPendingManifest(mount.moduleId),
      scriptName: null,
      entry: mountEntryUrl(mount, { moduleId: mount.moduleId, scriptName: mount.moduleId, workersDevSubdomain: null }),
    };
  }

  // cfToken/accountId/npmSpec 的存在性由 InstallRequestSchema.superRefine 保证（上传形态才要求）
  const cfToken = input.cfToken!;
  const accountId = input.accountId!;
  const installed = await installNpmModule({
    npmSpec: input.npmSpec!,
    cfToken,
    accountId,
    scriptName: input.scriptName,
  });
  const moduleId = installed.manifest.id;

  if (mount.kind === 'zone') {
    const zone = await findZoneForDomain(cfToken, mount.domain);
    if (!zone) {
      throw new CfRoutingError(`账号下找不到 ${mount.domain} 的 zone（Token 需要 Zone 读权限）`, 400);
    }
    await ensureWorkerRoute(cfToken, zone.id, moduleRoutePattern(mount.domain, moduleId), installed.scriptName);
    return {
      manifest: installed.manifest,
      scriptName: installed.scriptName,
      entry: mountEntryUrl(mount, { moduleId, scriptName: installed.scriptName, workersDevSubdomain: null }),
    };
  }

  // workers.dev：没有账号子域就给可操作错误，不回落拼假 URL（#273 教训）
  const subdomain = await accountWorkersDevSubdomain(cfToken, accountId);
  if (!subdomain) {
    throw new CfRoutingError('账号还没有 workers.dev 子域：先在 Cloudflare 控制台开通再重试', 400);
  }
  await enableWorkerWorkersDev(cfToken, accountId, installed.scriptName);
  return {
    manifest: installed.manifest,
    scriptName: installed.scriptName,
    entry: mountEntryUrl(mount, { moduleId, scriptName: installed.scriptName, workersDevSubdomain: subdomain }),
  };
}

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
      { userId: session.uid, moduleId, name: profile?.name ?? session.name, profileRevision: profile?.revision, avatarUrl: profile?.avatarKey == null ? undefined : profileAvatarUrl(c.req.url, profile.avatarKey), username: profile?.username ?? undefined, email: profile?.email ?? undefined, identitySource: profile?.identitySource ?? undefined },
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

  /**
   * 运行时装配（#349 模式一，决策 #109；#369 挂载选择）：装后增补单个模块。
   *
   * 凭证纪律（#165）：`cfToken` 只做本次请求的 CF 调用，`finally` 里连请求体副本一起抹掉；
   * 审计只记模块 id（不记 token，也不记 token 出现在 URL/错误文案里）。
   * 注册与落点列与既有注册同一写入口 upsertModule——不另开旁路写库。
   *
   * existing（#369 用户定案）：管理员自己部署好、有可达地址时，只填「模块 id + 模块地址」
   * 登记一行（mode=direct、enabled→active），不读 npm 包、不碰 CF。
   * **已知缺口**：这种模块没接入码，`POST /api/modules/connect-manifest`（按 keyHash 反查）
   * 走不了，所以它没有自报清单的通道——manifest 停在 0.0.0 占位，版本/图标在列表里看不到。
   * 本 PR 不解决，不假装能跑。
   * id 已存在（任何 lifecycle）→ 409，整行不动：不能把已装好的模块（或反连记账的 pending 行，
   * 及其 credential_hash）悄悄覆盖；与 connect-register 同一语义。
   * （检查+写入不是单条 SQL 原子操作；装配是管理员低频动作，此处不做并发优化，
   *  upsertModule 的 SQL 不在本 PR 开洞。）
   */
  app.post('/api/admin/modules/install', async (c) => {
    const parsed = InstallRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid install request', detail: z.prettifyError(parsed.error) }, 400);
    }
    const input = parsed.data;
    const mount: ModuleMount = input.mount;
    try {
      if (mount.kind === 'existing') {
        const taken = await c.env.CORE_DB.prepare('SELECT id FROM module_registry WHERE id = ?')
          .bind(mount.moduleId)
          .first<{ id: string }>();
        if (taken) {
          return c.json({ error: 'module already installed' }, 409);
        }
      }
      const mounted = await installWithMount(input, mount);
      const registration = ModuleRegistrationSchema.safeParse({
        id: mounted.manifest.id,
        enabled: true,
        manifest: mounted.manifest,
        // 三种挂载都是直连接入（#369）：有没有对外地址由 entry 表达，不由 mode 表达
        mode: 'direct',
        entry: mounted.entry,
        storage_level: input.storageLevel ?? null,
      });
      if (!registration.success) {
        return c.json({ error: 'invalid entry', detail: z.prettifyError(registration.error) }, 400);
      }
      const entry = await upsertModule(c.env.CORE_DB, registration.data);
      await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_upserted', mounted.manifest.id);
      return c.json(
        { ...entry, scriptName: mounted.scriptName, version: mounted.manifest.version },
        201,
      );
    } catch (error) {
      if (error instanceof RuntimeInstallError) {
        return c.json({ error: error.message }, error.status);
      }
      if (error instanceof CfRoutingError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    } finally {
      // 用后即焚：请求体副本与本作用域入参都不留凭证
      wipeCredential(input);
    }
  });

  /**
   * 账号下 active zone 清单（「挂到」下拉的数据源）。
   * token 走 `x-cf-token` 头而不是 query：GET 无法带 body，而 URL 会进访问日志（#165）。
   * 只读且用后即焚，不落库、不进审计。
   */
  app.get('/api/admin/modules/cf/zones', async (c) => {
    const accountId = c.req.query('accountId');
    const holder = { cfToken: c.req.header('x-cf-token') ?? '' };
    try {
      if (!accountId || !holder.cfToken) {
        return c.json({ error: 'accountId（query）与 x-cf-token（header）必填' }, 400);
      }
      return c.json(await listAccountZones(holder.cfToken));
    } catch (error) {
      if (error instanceof CfRoutingError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    } finally {
      wipeCredential(holder);
    }
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
   * 反连接入：记账预注册（#349，决策 #109 两段式的第①段）。
   * 动线：用户在工作台「新增模块」选 connect 形态 → 浏览器本地 WebCrypto 生成 key、
   * 算 hex(SHA-256(key)) → 本端点记账；之后用户把 core 可达地址 + key 写进模块 env 部署，
   * 模块主动外连（dial-home）完成注册与保活 → 工作台「测试连接」绿 → 保存。
   * 保存 = 两段式的第②段：复用既有 POST /api/admin/modules upsert 激活（enabled=true）。
   *
   * 本端点语义 = 写一行 mode='connect' + credential_hash + entry=core 隧道路由的 pending 态：
   * - 新建行：lifecycle=pending、enabled=0、0.0.0 占位 manifest（真清单归保存段）；
   *   pending 仍可拨号做「测试连接」（握手只拒 disabled）。
   * - 重放（双击/重试）：只覆盖 credential_hash（及本次给出的 storageLevel），**保留
   *   manifest/version/enabled**——模块自报的真清单不能被重记账清回占位。
   * - 已 active/disabled 行：409 拒写，整行不动——不能把已装好的模块打回 pending。
   *   「检查+写入」由单条 SQL 的 ON CONFLICT ... WHERE 原子承载，避免与管理员启停竞态。
   * - keyHash 形状（64 位小写 hex，浏览器 hex(SHA-256(key))）由 CREDENTIAL_HASH_PATTERN 单点校验；
   *   明文 key 只在浏览器内存与一次性展示里，core 全程只见哈希（#102 措辞修订，决策 #109）。
   * - 权限：管理员会话（requireAdmin 由组合根 /api/admin/* 前缀统一挂）——接入是实例级管理动作。
   */
  app.post('/api/admin/modules/connect-register', async (c) => {
    const parsed = ConnectRegisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid connect registration', detail: z.prettifyError(parsed.error) }, 400);
    }
    const { moduleId, keyHash, storageLevel } = parsed.data;
    // core 分配路由（决策 #109）：反连模块的接入点 = core 自己的隧道路由 /m/<id>/，
    // 记账时刻即可知（请求 origin）。这也是 0012 CHECK（connect 必填 entry）的满足方式
    // ——记账段不放松数据层不变式， entry 指向的隧道面由 T2（core 隧道面）承接。
    const routeEntry = `${new URL(c.req.url).origin}/m/${moduleId}/`;
    // 两段式语义承载于此：新建 = pending（enabled=false），第②段保存时经既有 upsert 激活。
    // 已 active/disabled 行拒绝覆盖（null → 409）；已 pending 行保留 manifest/version/enabled。
    const entry = await registerPendingConnectModule(c.env.CORE_DB, {
      moduleId,
      keyHash,
      entry: routeEntry,
      storageLevel: storageLevel ?? null,
    });
    if (!entry) {
      return c.json({ error: 'module already installed (lifecycle active/disabled)' }, 409);
    }
    await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_connect_registered', moduleId);
    return c.json({ id: entry.id, mode: entry.mode, enabled: entry.enabled, lifecycle: entry.lifecycle }, 201);
  });

  /** 全量列表（管理端，含停用）。 */
  app.get('/api/admin/modules', async (c) => {
    return c.json(await listModules(c.env.CORE_DB));
  });

  // ---- 模块配置（#349 U8 ④）：声明（manifest 快照）+ 存值（0015 config_values）----

  /**
   * 读模块配置（工作台行内「设置」表单的数据源）：字段声明 + 当前值。
   * secret 已存值打码 '***'（人话提示「留空保持不变」由前端补）；无声明回空数组不 404
   * （工作台只对 manifest.config 非空的行渲染入口，但直接打 API 也要有稳定形状）。
   */
  app.get('/api/admin/modules/:id/config', async (c) => {
    const moduleId = c.req.param('id');
    const state = await getModuleConfig(c.env.CORE_DB, moduleId);
    if (!state) {
      return c.json({ error: 'module not found' }, 404);
    }
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state.values)) {
      const field = state.config.find((f) => f.key === key);
      values[key] = field?.type === 'secret' && value !== undefined && value !== null && value !== '' ? CONFIG_SECRET_MASK : value;
    }
    return c.json({ config: state.config, values });
  });

  /**
   * 存模块配置（工作台「设置」保存）：values 逐 key 按 manifest.config schema 校验
   * （校验单点 services/module-config.ts：unknown key 拒 / type 校验 / required 拒 /
   * oauth 拒 / secret 掩码与空串 = 保持）。校验过才写 0015 config_values 列。
   */
  app.put('/api/admin/modules/:id/config', async (c) => {
    const moduleId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { values?: unknown } | null;
    if (typeof body?.values !== 'object' || body.values === null || Array.isArray(body.values)) {
      return c.json({ error: 'body must be { values: Record<string, unknown> }' }, 400);
    }
    const rawValues = body.values as Record<string, unknown>;
    const state = await getModuleConfig(c.env.CORE_DB, moduleId);
    if (!state) {
      return c.json({ error: 'module not found' }, 404);
    }
    let saved: Record<string, unknown>;
    try {
      saved = validateModuleConfigValues(state.config, rawValues, state.values);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
    const ok = await saveModuleConfig(c.env.CORE_DB, moduleId, saved);
    if (!ok) {
      return c.json({ error: 'module not found' }, 404);
    }
    await audit(c.env.CORE_DB, (await readSession(c))!.uid, 'module_config_updated', moduleId);
    // 响应只回 id：saved.values 可能含 secret 明文，不回显（读侧 GET 已打码）
    return c.json({ id: moduleId });
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
