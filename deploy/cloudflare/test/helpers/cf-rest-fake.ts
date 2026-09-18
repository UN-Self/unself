// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CF REST 账户态替身（#244 测试边界）：把「账户里有什么」做成内存状态机，
 * 按真机实测的信封/端点形状回放。runNineSteps 的行为断言全部落在
 * 「发了哪些请求 / 账户态如何变化」上——不再解析 wrangler 命令行。
 *
 * 已覆盖端点（与 src/rest 对齐）：
 * accounts · d1 database(list/create/query/import) · kv namespaces · r2 buckets ·
 * workers scripts(put/settings/secrets/subdomain) · assets-upload-session ·
 * zones(lookup/routes/dns/total_tls) · workers/domains。
 */

export interface FakeAccountOptions {
  existingD1?: string[];
  existingBuckets?: string[];
  existingKv?: string[];
  /** worker 名 → 已配置 secret 名集合。 */
  existingSecrets?: Record<string, string[]>;
  /** 预置已存在的 worker 脚本（stub 场景：脚本在、DO 类未建）。 */
  existingWorkers?: string[];
  /** 预置模块记账表内容（表名 → 已记账名）：模拟「上次真部署已记账」的收敛态。 */
  existingLedger?: Record<string, string[]>;
  /** core 库 instance_config.setup_done（步骤⑧ → sealed）。 */
  setupDone?: boolean;
  /** core 库已有未消费 setup token（重跑复用）。 */
  existingSetupToken?: string | null;
  /** zone 名 → id（domain 部署模式）。 */
  zones?: Record<string, string>;
  /** 既有 zone 路由 [pattern, script]。 */
  routes?: Array<[string, string]>;
  /** 既有 DNS A 记录名。 */
  dnsA?: string[];
  /** 模拟 wrangler 时代老库记账（d1_migrations 已应用文件名）。 */
  legacyLedger?: string[];
  /** 让含 marker 的迁移文件 import 失败（#248 迁移失败三要素定位的注入点）。 */
  importFailure?: { marker: string; errors: string[] };
}

const UUID = 'a1b2c3d4-0000-0000-0000-000000000001';

interface Call {
  method: string;
  url: string;
  body?: unknown;
  /** multipart 上传时的 metadata JSON。 */
  metadata?: Record<string, unknown>;
}

export function makeCfRestFake(options: FakeAccountOptions = {}) {
  const state = {
    d1: new Map<string, string>([...(options.existingD1 ?? [])].map((n) => [n, UUID])),
    buckets: new Set(options.existingBuckets ?? []),
    kv: new Map<string, string>([...(options.existingKv ?? [])].map((t) => [t, 'd1d2e3f4-0000-0000-0000-0000000000d5'])),
    secrets: new Map<string, Set<string>>(
      Object.entries(options.existingSecrets ?? {}).map(([w, list]) => [w, new Set(list)]),
    ),
    uploads: [] as Array<{ worker: string; metadata: Record<string, unknown> }>,
    existingWorkers: new Set<string>(options.existingWorkers ?? []),
    // 已有 worker（existingSecrets 出现过 → worker 必已存在）
    assetManifests: [] as Array<Record<string, { hash: string }>>,
    assetUploads: [] as string[][],
    secretPuts: [] as Array<{ worker: string; name: string }>,
    setupDone: options.setupDone ?? false,
    setupToken: options.existingSetupToken ?? null,
    workersDevEnabled: new Set<string>(),
    routes: new Map<string, string>((options.routes ?? []).map(([p, s]) => [p, s])),
    dnsA: new Set(options.dnsA ?? []),
    totalTlsCalls: 0,
    // core 库的迷你 SQL 态（module_registry / setup_tokens / 记账表）
    registry: new Map<string, { enabled: number; version: string; manifest_json: string }>(),
    importEtags: new Set<string>(),
    importCalls: [] as Array<{ action: string; etag?: string; bookmark?: string }>,
    ledgerTables: new Set<string>(Object.keys(options.existingLedger ?? {})),
    ledgerRows: new Map<string, Set<string>>(
      Object.entries(options.existingLedger ?? {}).map(([table, rows]) => [table, new Set(rows)]),
    ),
    legacyLedger: options.legacyLedger ?? [],
    subdomain: 'test-subdomain',
  };

  const calls: Call[] = [];
  /** #248：import 失败明细（PUT 命中 marker 后置入，poll 时回给调用方）。 */
  let importError: string[] | null = null;
  for (const w of state.secrets.keys()) state.existingWorkers.add(w);

  const env = (result: unknown, ok = true, code = 0, message = '', status = ok ? 200 : 400): Response =>
    new Response(JSON.stringify(ok ? { success: true, result, errors: [] } : { success: false, result: null, errors: [{ code, message }] }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown;
    let metadata: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body instanceof FormData) {
      const metaRaw = (init.body as FormData).get('metadata');
      if (typeof metaRaw === 'string') {
        metadata = JSON.parse(metaRaw) as Record<string, unknown>;
        body = metadata;
      }
      // form 里其余字段（模块文件）不在断言面
    } else if (init?.body instanceof Uint8Array) body = init.body;

    // ---- 无关路径直接 404（测试里不该出现）----
    const A = 'f7351bdd-acc0-0000-0000-000000000001';
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/client\/v4/, '');

    calls.push({ method, url: path, body, metadata });

    // ---- accounts ----
    if (path === '/accounts' && method === 'GET') return env([{ id: A, name: 'probe' }]);

    // ---- D1：list / create ----
    if (path.endsWith('/d1/database') && method === 'GET') return env([...state.d1].map(([name, uuid]) => ({ name, uuid })));
    if (path.endsWith('/d1/database') && method === 'POST') {
      const name = (body as { name: string }).name;
      state.d1.set(name, UUID);
      return env({ name, uuid: UUID });
    }

    // ---- D1：query（迷你 SQL 态）----
    const qm = path.match(/\/d1\/database\/([^/]+)\/query$/);
    if (qm && method === 'POST') {
      const { sql, params } = body as { sql: string; params?: unknown[] };
      return d1Query(sql, params ?? []);
    }

    // ---- D1：import（init / poll + presigned PUT）----
    const im = path.match(/\/d1\/database\/([^/]+)\/import$/);
    if (im && method === 'POST') {
      const action = (body as { action: string }).action;
      if (action === 'init') {
        const etag = (body as { etag: string }).etag;
        state.importCalls.push({ action, etag });
        if (state.importEtags.has(etag)) {
          return env({ status: 'complete', num_queries: 3, final_bookmark: 'bm-done' });
        }
        state.importEtags.add(etag);
        return env({ upload_url: `https://r2-fake.example/upload?etag=${etag}`, at_bookmark: 'bm1' });
      }
      if (action === 'poll') {
        state.importCalls.push({ action, bookmark: (body as { current_bookmark: string }).current_bookmark });
        // #248：注入的 import 失败（迁移失败定位测试用；真实 D1 在轮询里回 errors 明细）
        if (importError) return env({ status: 'error', errors: importError });
        return env({ status: 'complete', num_queries: 3, final_bookmark: 'bm-done' });
      }
    }
    if (path.startsWith('/upload?etag=') && method === 'PUT') {
      const sqlText = body instanceof Uint8Array ? new TextDecoder().decode(body) : '';
      if (options.importFailure && sqlText.includes(options.importFailure.marker)) {
        importError = options.importFailure.errors;
        return new Response(JSON.stringify({ status: 'pending', at_bookmark: 'bm-err' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'complete', num_queries: 3, final_bookmark: 'bm-done' }), { status: 200 });
    }

    // ---- KV ----
    if (path.endsWith('/storage/kv/namespaces') && method === 'GET') {
      return env([...state.kv].map(([title, id]) => ({ id, title })));
    }
    if (path.endsWith('/storage/kv/namespaces') && method === 'POST') {
      const title = (body as { title: string }).title;
      state.kv.set(title, 'd1d2e3f4-0000-0000-0000-0000000000d5');
      return env({ id: 'd1d2e3f4-0000-0000-0000-0000000000d5', title });
    }

    // ---- R2 ----
    if (path.endsWith('/r2/buckets') && method === 'GET') {
      return env({ buckets: [...state.buckets].map((name) => ({ name })) });
    }
    if (path.endsWith('/r2/buckets') && method === 'POST') {
      state.buckets.add((body as { name: string }).name);
      return env({ name: (body as { name: string }).name });
    }

    // ---- workers.dev 子域 ----
    if (path === `/accounts/${A}/workers/subdomain` && method === 'GET') return env({ subdomain: 'test-subdomain' });
    const subEn = path.match(/\/workers\/scripts\/([^/]+)\/subdomain$/);
    if (subEn && method === 'POST') {
      state.workersDevEnabled.add(decodeURIComponent(subEn[1]!));
      return env({ enabled: true });
    }

    // ---- worker scripts ----
    const scriptPath = path.match(/\/workers\/scripts\/([^/]+)(\/.*)?$/);
    if (scriptPath) {
      const worker = decodeURIComponent(scriptPath[1]!);
      const rest = scriptPath[2] ?? '';
      if (rest === '' && method === 'PUT') {
        state.uploads.push({ worker, metadata: metadata! });
        state.existingWorkers.add(worker);
        return env({ id: worker });
      }
      if (rest === '/settings' && method === 'GET' && !state.existingWorkers.has(worker)) {
        // 脚本不存在（首次部署前）：CF 真机 404 → hasWorkerSecret=false / isWorkerNew=true
        return new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 10049, message: 'workers.api.error.script_not_found' }] }), { status: 404 });
      }
      if (rest === '/settings' && method === 'GET') {
        const secrets = state.secrets.get(worker) ?? new Set();
        return env({
          bindings: [...secrets].map((name) => ({ type: 'secret_text', name })),
        });
      }
      if (rest === '/secrets' && method === 'PUT') {
        const { name } = body as { name: string };
        (state.secrets.get(worker) ?? state.secrets.set(worker, new Set()).get(worker)!).add(name);
        state.secretPuts.push({ worker, name });
        return env({ name });
      }
    }

    // ---- assets ----
    if (path.endsWith('/assets-upload-session') && method === 'POST') {
      const manifest = (body as { manifest: Record<string, { hash: string }> }).manifest ?? {};
      // 真机契约（2026-09-18 探针实测，错误码 10304）：manifest key 必须 / 开头
      for (const key of Object.keys(manifest)) {
        if (!key.startsWith('/')) {
          return Response.json({ success: false, errors: [{ code: 10304, message: 'validation failed: assets manifest key must start with /' }] }, { status: 400 });
        }
      }
      state.assetManifests.push(manifest);
      // 全部哈希视为缺失 → 触发批量上传分支（真机首传同形）；裸响应非信封
      const hashes = Object.values(manifest).map((e) => e.hash);
      return Response.json({ jwt: 'asset-session-jwt', buckets: hashes.map((h) => [h]) });
    }
    if (path.startsWith('/accounts/') && path.includes('/workers/assets/upload') && method === 'POST') {
      state.assetUploads.push([...((init?.body as FormData)?.keys?.() ?? [])]);
      return Response.json({ jwt: 'asset-completion-jwt' });
    }

    // ---- zone：lookup / routes / dns / total_tls / custom domains ----
    if (path.startsWith('/zones?') && method === 'GET') {
      const name = decodeURIComponent(path.split('name=')[1] ?? '').split('&')[0]!;
      const id = (options.zones ?? {})[name];
      return env(id ? [{ id, name }] : []);
    }
    const zm = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    if (zm) {
      const rest = zm[2] ?? '';
      if (rest === '/workers/routes' && method === 'GET') {
        return env([...state.routes].map(([pattern, script], i) => ({ id: `rt-${i}`, pattern, script })));
      }
      if (rest === '/workers/routes' && method === 'POST') {
        const { pattern, script } = body as { pattern: string; script: string };
        state.routes.set(pattern, script);
        return env({ id: `rt-${state.routes.size}` });
      }
      const routeUpd = rest.match(/^\/workers\/routes\/(.+)$/);
      if (routeUpd && method === 'DELETE') {
        const id = routeUpd[1]!;
        // id 形如 rt-<index>；同时支持 pattern 直接删除（测试便利）
        const idx = Number(id.replace('rt-', ''));
        const pattern = Number.isNaN(idx) ? id : [...state.routes.keys()][idx];
        if (pattern) state.routes.delete(pattern);
        return env({ id });
      }
      if (rest.startsWith('/dns_records') && method === 'GET') {
        return env([...state.dnsA].map((name) => ({ id: `dns-${name}`, content: '192.0.2.1', proxied: true })));
      }
      if (rest === '/dns_records' && method === 'POST') {
        state.dnsA.add((body as { name: string }).name);
        return env({ id: 'dns-new' });
      }
      if (rest === '/acm/total_tls' && method === 'POST') {
        state.totalTlsCalls++;
        return env({ enabled: true });
      }
    }
    if (path === `/accounts/${A}/workers/domains` && method === 'GET') return env([]);

    return new Response(JSON.stringify({ success: false, result: null, errors: [{ code: 7003, message: `fake 未实现：${method} ${path}` }] }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  /** 迷你 SQL 执行（仅覆盖共用 SQL 的形状）。 */
  function d1Query(sql: string, params: unknown[]): Response {
    const envRow = (rows: Array<Record<string, unknown>>, changes = 0): Response =>
      new Response(
        JSON.stringify({ success: true, result: [{ results: rows, success: true, meta: { changes, duration: 0 } }], errors: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    // 记账表存在性探测
    if (sql.startsWith('SELECT COUNT(*)')) {
      const table = params[1] as string;
      const exists = state.ledgerTables.has(table) || table === 'd1_migrations';
      return envRow([{ n: exists ? 1 : 0 }]);
    }
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS unself_migrations_')) {
      const table = /unself_migrations_[a-z0-9_]+/.exec(sql)![0];
      state.ledgerTables.add(table);
      state.ledgerRows.set(table, state.ledgerRows.get(table) ?? new Set());
      return envRow([], 0);
    }
    if (sql.startsWith('INSERT INTO unself_migrations_') || sql.startsWith('INSERT OR IGNORE INTO unself_migrations_')) {
      const table = /unself_migrations_[a-z0-9_]+/.exec(sql)![0];
      state.ledgerRows.set(table, state.ledgerRows.get(table) ?? new Set());
      state.ledgerRows.get(table)!.add(String(params[0]));
      return envRow([], 1);
    }
    if (sql.startsWith('SELECT name FROM unself_migrations_')) {
      const table = /unself_migrations_[a-z0-9_]+/.exec(sql)![0];
      return envRow([...(state.ledgerRows.get(table) ?? [])].sort().map((name) => ({ name })));
    }
    if (sql === 'SELECT name FROM d1_migrations ORDER BY name') {
      if (state.legacyLedger.length > 0) return envRow(state.legacyLedger.map((name) => ({ name })));
      return env(null, false, 7500, 'no such table: d1_migrations', 400);
    }
    if (sql.startsWith('INSERT INTO module_registry')) {
      const [id, enabled, version, manifestJson] = params as [string, number, string, string];
      state.registry.set(id, { enabled, version, manifest_json: manifestJson });
      return envRow([{ id, enabled, version, manifest_json: manifestJson }], 1);
    }
    if (sql.startsWith('UPDATE module_registry')) {
      const [id, enabled] = params as [string, number];
      const row = state.registry.get(id);
      if (!row) return envRow([], 0);
      row.enabled = enabled;
      return envRow([{ id, enabled, version: row.version, manifest_json: row.manifest_json }], 1);
    }
    if (sql.startsWith('SELECT id, enabled, version, manifest_json FROM module_registry')) {
      return envRow(
        [...state.registry]
          .sort()
          .map(([id, r]) => ({ id, enabled: r.enabled, version: r.version, manifest_json: r.manifest_json })),
      );
    }
    if (sql.includes('instance_config')) {
      return envRow([{ sealed: state.setupDone ? 1 : 0, token: state.setupToken }]);
    }
    if (sql.startsWith('INSERT INTO setup_tokens')) {
      state.setupToken = String(params[0]);
      return envRow([], 1);
    }
    if (sql.startsWith('UPDATE setup_tokens')) {
      const okConsume = state.setupToken === String(params[0]);
      if (okConsume) state.setupToken = null;
      return envRow([], okConsume ? 1 : 0);
    }
    if (sql.startsWith('SELECT 1 AS ok FROM setup_tokens')) {
      return envRow(state.setupToken === String(params[0]) ? [{ ok: 1 }] : []);
    }
    return env(null, false, 7500, `fake 未实现的 SQL：${sql.slice(0, 60)}`, 400);
  }

  return {
    fetchImpl,
    calls,
    state,
    /** 便捷断言：按子串找请求。 */
    find(sub: string): Call | undefined {
      return calls.find((c) => c.url.includes(sub));
    },
    filter(sub: string): Call[] {
      return calls.filter((c) => c.url.includes(sub));
    },
  };
}

export type CfRestFake = ReturnType<typeof makeCfRestFake>;
