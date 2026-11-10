// SPDX-License-Identifier: AGPL-3.0-only
/**
 * connect 反连接口（issue #349，决策 #108 反连形态）：
 *
 * - WS /api/modules/connect-ws?moduleId=&keyHash= —— dial-home 主形态（CF 落点挂
 *   TunnelRoom DO，hibernation 省费；决策 #106：DO 是过渡事实非承诺）；
 * - HTTP 兜底 POST /api/modules/connect-poll —— 长轮询 pending 请求（模块无法持长连时用；
 *   回答走 POST /api/modules/connect-respond，帧形状同 WS response 帧）；
 * - GET /api/modules/connect-status?moduleId= —— 「测试连接」查询在线状态（在线 ≠ enabled）。
 *
 * 验签纪律（决策 #51 照搬）：入站先验——upgrade/poll/respond 都过 verifyConnectCredential
 * （registry credential_hash 单点核对），核不过 404/403，不回明文原因给连接方（管理员排障
 * 走审计）。重连必重新核哈希：upgrade/poll/respond 路径均无会话缓存（测试锁定）。
 * 关闭码语义：1008 policy violation = 凭据不配/需重新配置；凭据被吊销（按帧重验败）也关 1008
 * ——客户端两种码都应触发「重新核验再连」，1018 的区分度归模块 SDK（测试锁定 1008 语义）。
 */
import { Hono } from 'hono';

import { TUNNEL_INTERNAL_ORIGIN } from '../do/TunnelRoom';
import { lookupConnectModule, verifyConnectCredential } from '../services/connect-registry';

/** Bindings + 隧道 DO 绑定（生产 wrangler durable_objects；单测/Node 运行体注入 stub）。 */
export interface ConnectBindings {
  CORE_DB: D1Database;
  /** 隧道 DO（TunnelRoom）；未绑定 = 隧道运行时不可用（Node 运行体注入同名面 stub）。 */
  CONNECT_TUNNEL?: DurableObjectNamespace;
}


/**
 * DO 内部请求（stub.fetch 专用；TUNNEL_INTERNAL_ORIGIN 仅内部可达）。
 * base 传入时按其**原样保留方法与头**（含 WS upgrade 的 `Upgrade`/`Connection`——
 * 真机取证教训：重建 Request 丢 upgrade 头会被 TunnelRoom.handleConnect 拒 400，
 * 单测直打 DO 内部路由测不到这层）。
 */
function internalRequest(
  path: string,
  params: Record<string, string>,
  base?: Request,
): Request {
  const url = new URL(`${TUNNEL_INTERNAL_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return base ? new Request(url, base) : new Request(url);
}

export function registerConnectRoutes(app: Hono<{ Bindings: ConnectBindings }>): void {
  const connect = new Hono<{ Bindings: ConnectBindings }>();

  /**
   * dial-home WS：upgrade 时按 keyHash 反查模块（#108 env 契约只有地址+key；模块不报 id）。
   * （未知凭据 404 / 形状或不配 403，HTTP 状态码承载
   * 「未通过握手」；凭据吊销类断连由 DO 按帧重验后关 1008）。核过后 upgrade 请求原样
   * 转进 TunnelRoom（accept + serializeAttachment 绑 moduleId+keyHash，见 TunnelRoom.ts）。
   */
  connect.get('/api/modules/connect-ws', async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'expected websocket upgrade' }, 400);
    }
    const keyHash = c.req.query('keyHash') ?? '';
    const gate = await lookupConnectModule(c.env.CORE_DB, keyHash);
    if (!gate.ok) {
      return c.json({ error: gate.error }, gate.status);
    }
    const moduleId = gate.moduleId;
    const ns = c.env.CONNECT_TUNNEL;
    if (!ns) {
      // 无隧道运行时（生产装配器未挂 DO / 测试未注入）：503 拒而不降级。
      return c.json({ error: 'tunnel runtime not available' }, 503);
    }
    const stub = ns.get(ns.idFromName(moduleId));
    return stub.fetch(
      // upgrade 头必须原样带进 DO（handleConnect 以它判定 WS 交接；见 internalRequest 注释）
      internalRequest('/connect', { moduleId, keyHash }, c.req.raw),
    );
  });

  /**
   * HTTP 兜底长轮询：模块侧拿 pending 请求帧。认证参数走查询（与 WS 同面——控制面
   * 凭据在查询里是任务书已定的形态；审计/日志纪律同 #102：keyHash 是哈希非明文）。
   * 响应：{ requests: TunnelRequestFrame[] }；空轮询带 waitMs 时 DO 内挂等待（上限截断）。
   */
  connect.post('/api/modules/connect-poll', async (c) => {
    const keyHash = c.req.query('keyHash') ?? '';
    const gate = await lookupConnectModule(c.env.CORE_DB, keyHash);
    if (!gate.ok) {
      return c.json({ error: gate.error }, gate.status);
    }
    const moduleId = gate.moduleId;
    const ns = c.env.CONNECT_TUNNEL;
    if (!ns) {
      return c.json({ error: 'tunnel runtime not available' }, 503);
    }
    const stub = ns.get(ns.idFromName(moduleId));
    return stub.fetch(
      internalRequest('/poll', {
        moduleId,
        keyHash,
        waitMs: c.req.query('waitMs') ?? '0',
      }),
    );
  });

  /** 模块对轮询帧的 HTTP 回答（body = response 帧；形状/配对/纪律在 DO 侧核）。 */
  connect.post('/api/modules/connect-respond', async (c) => {
    const keyHash = c.req.query('keyHash') ?? '';
    const gate = await lookupConnectModule(c.env.CORE_DB, keyHash);
    if (!gate.ok) {
      return c.json({ error: gate.error }, gate.status);
    }
    const moduleId = gate.moduleId;
    const ns = c.env.CONNECT_TUNNEL;
    if (!ns) {
      return c.json({ error: 'tunnel runtime not available' }, 503);
    }
    const stub = ns.get(ns.idFromName(moduleId));
    const url = new URL(`${TUNNEL_INTERNAL_ORIGIN}/respond`);
    url.searchParams.set('moduleId', moduleId);
    url.searchParams.set('keyHash', keyHash);
    return stub.fetch(
      new Request(url, {
        method: 'POST',
        body: await c.req.arrayBuffer(),
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  /**
   * 在线状态（「测试连接」查询；在线 ≠ enabled，两层语义见 connect-registry.ts 注释）。
   * CF 落点：TunnelRoom DO 存活 WS 会话真值；无 DO 绑定 = 必不在线（人话 reason）。
   */
  connect.get('/api/modules/connect-status', async (c) => {
    const moduleId = c.req.query('moduleId') ?? '';
    const ns = c.env.CONNECT_TUNNEL;
    if (!ns) {
      return c.json({ moduleId, online: false, reason: 'tunnel runtime not available' });
    }
    const stub = ns.get(ns.idFromName(moduleId));
    return stub.fetch(internalRequest('/status', { moduleId }));
  });

  app.route('/', connect);
}
