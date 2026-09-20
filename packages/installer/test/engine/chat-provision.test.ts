// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 装配单元行为测试（#219；#244 REST 化后）：
 * - ensureChatResources：chat 专属 D1/KV 查漏补建（注入 RestClient 替身）；
 * - generateChatKeyring：AES-256 密钥环形状（worker encryption.js 可解析）；
 * - readChatPackageConfig：包配置解析 + 形状人话报错；
 * - chatWranglerConfig：/m/chat/* 路由、D1/KV/R2/DO 绑定、vars 直通、确定性（字节级一致）；
 * - moduleWorkerEntry：包 main 入口解析（hello=src/index.ts、chat=worker/src/index.js）。
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chatDbName,
  chatKvName,
  chatR2Name,
  chatWranglerConfig,
  ensureChatResources,
  generateChatKeyring,
  readChatPackageConfig,
} from '../../src/engine/chat-provision';
import { moduleWorkerEntry } from '../../src/engine/assemble';
import { RestClient } from '../../src/engine/rest/client';
import type { UnselfConfig } from '../../src/engine/config';


/** REST 替身：按请求序列回放（D1 list/create、KV list/create 的 v4 信封）。 */
function restFake(options?: { existingD1?: string[]; existingKv?: string[] }) {
  const dbId = 'b1b2c3d4-0000-0000-0000-0000000000c4';
  const kvId = 'd1d2e3f4-0000-0000-0000-0000000000d5';
  const d1 = new Set(options?.existingD1 ?? []);
  const kv = new Set(options?.existingKv ?? []);
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const env = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { status: 200 });
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith('/d1/database')) {
      if (method === 'GET') return env([...d1].map((name) => ({ name, uuid: dbId })));
      if (method === 'POST') {
        const name = (body as { name: string }).name;
        if (d1.has(name)) return Response.json({ success: false, result: null, errors: [{ code: 7502, message: 'already exists' }] }, { status: 400 });
        d1.add(name);
        return env({ name, uuid: dbId });
      }
    }
    if (url.endsWith('/storage/kv/namespaces')) {
      if (method === 'GET') return env([...kv].map((title) => ({ id: kvId, title })));
      if (method === 'POST') {
        const title = (body as { title: string }).title;
        if (kv.has(title)) return Response.json({ success: false, result: null, errors: [{ code: 10014, message: 'namespace exists' }] }, { status: 400 });
        kv.add(title);
        return env({ id: kvId, title });
      }
    }
    return env(null);
  }) as typeof fetch;
  return { client: new RestClient({ token: 't', fetchImpl: impl }), calls, dbId, kvId };
}


describe('ensureChatResources（REST 查漏补建）', () => {
  it('空账户：D1/KV 各建一次，id 返回', async () => {
    const fake = restFake();
    const logs: string[] = [];
    const { dbId, kvId } = await ensureChatResources(fake.client, 'ACC', (m) => logs.push(m));
    expect(dbId).toBe(fake.dbId);
    expect(kvId).toBe(fake.kvId);
    expect(fake.calls.some((c) => c.method === 'POST' && c.url.endsWith('/d1/database'))).toBe(true);
    expect(fake.calls.some((c) => c.method === 'POST' && c.url.endsWith('/storage/kv/namespaces'))).toBe(true);
    expect(logs.some((l) => l.includes(chatDbName()))).toBe(true);
  });

  it('已存在：零 create（幂等），list 命中直接返回 id', async () => {
    const fake = restFake({ existingD1: [chatDbName()], existingKv: [chatKvName()] });
    await ensureChatResources(fake.client, 'ACC', () => {});
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('generateChatKeyring（AES-256-GCM 密钥环）', () => {
  it('形状与 worker encryption.js 解析契约一致：activeKeyId + keys.v1 = 32B 标准 base64', () => {
    const keyring = JSON.parse(generateChatKeyring()) as { activeKeyId: string; keys: Record<string, string> };
    expect(keyring.activeKeyId).toBe('v1');
    const key = keyring.keys.v1!;
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('两次生成互不相同（随机性）', () => {
    expect(generateChatKeyring()).not.toBe(generateChatKeyring());
  });
});

describe('readChatPackageConfig（包配置子集解析）', () => {
  const REPO = new URL('../../../..', import.meta.url).pathname;

  it('真实包配置：vars/DO/migrations 全量解析，D1 绑定=DB', async () => {
    const pkg = await readChatPackageConfig(join(REPO, 'modules/chat'));
    expect(pkg.d1Binding).toBe('DB');
    expect(pkg.vars.ADMIN_USERNAMES).toBe('admin');
    expect(pkg.vars.MAX_FILE_SIZE).toBe('20971520');
    expect(pkg.doBindings).toEqual([
      { name: 'CHANNEL_ROOM', class_name: 'ChannelRoom' },
      { name: 'SCHEDULER', class_name: 'Scheduler' },
      { name: 'USER_INBOX', class_name: 'UserInbox' },
    ]);
    expect(pkg.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['ChannelRoom', 'Scheduler', 'UserInbox'] }]);
  });

  it('缺迁移链（migrations/chat/*.sql）/ D1 绑定形状不对 → 人话报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-pkg-'));
    await mkdir(join(dir, 'worker'), { recursive: true });
    await writeFile(join(dir, 'wrangler.jsonc'), '{"d1_databases":[]}');
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/形状不符/);
    await writeFile(join(dir, 'wrangler.jsonc'), '{"d1_databases":[{"binding":"DB","database_id":"x"}],"kv_namespaces":[{"binding":"OTHER","id":"y"}]}');
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/kv_namespaces/);
    await writeFile(join(dir, 'wrangler.jsonc'), '{"d1_databases":[{"binding":"DB"}],"kv_namespaces":[{"binding":"SESSIONS"}]}');
    // #248：chat 的 schema 走标准迁移链，包内 migrations/chat/ 缺失 → 装载即拒（不再有一次性灌 schema 豁免）
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/migrations\/chat/);
    await mkdir(join(dir, 'migrations', 'chat'), { recursive: true });
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/migrations\/chat/); // 空目录同样拒（无 .sql = 无法应用）
    await writeFile(join(dir, 'migrations', 'chat', '0001_baseline.sql'), 'PRAGMA foreign_keys = ON;');
    await expect(readChatPackageConfig(dir)).resolves.toMatchObject({ d1Binding: 'DB' });
    await rm(dir, { recursive: true, force: true });
  });

  it('真实 chat 包：迁移链在标准位置 migrations/chat/（#248 存储面去豁免的锚点）', () => {
    expect(existsSync(join(REPO, 'modules/chat/migrations/chat/0001_baseline.sql'))).toBe(true);
    expect(existsSync(join(REPO, 'modules/chat/worker/schema-baseline.sql'))).toBe(false);
  });
});

describe('chatWranglerConfig（部署配置生成）', () => {
  const base = {
    config: { domain: 'team.example.com', modules: [{ id: 'chat', source: 'npm:@unself/chat@0.1.0' }], storage: { provider: 'r2', bucket: 'unself-storage' } } as UnselfConfig,
    dbIds: { modules: 'modules-uuid', chat: 'chat-uuid' },
    kvId: 'kv-uuid',
    jwksJson: '{"keys":[]}',
    pkg: {
      vars: { ADMIN_USERNAMES: 'admin', MAX_FILE_SIZE: '20971520' },
      d1Binding: 'DB',
      doBindings: [{ name: 'CHANNEL_ROOM', class_name: 'ChannelRoom' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['ChannelRoom'] }],
    },
    assetsDir: 'chat/assets/frontend',
  };

  it('/m/chat/* 路由 + 专属 D1/KV/R2 + DO/migrations + vars 直通 + 前端 assets', () => {
    const cfg = JSON.parse(chatWranglerConfig(base)) as Record<string, any>;
    expect(cfg.name).toBe('unself-module-chat');
    expect(cfg.main).toBe('chat/worker.js');
    expect(cfg.routes).toEqual([{ pattern: 'team.example.com/m/chat/*', zone_name: undefined }]);
    expect(cfg.d1_databases).toEqual([{ binding: 'DB', database_name: chatDbName(), database_id: 'chat-uuid' }]);
    // #231：SESSIONS KV 已无 worker 写入/读取方（本地会话下架 + PATCH profile 停写），
    // 绑定暂由生成配置代持到 M3 清退（取舍见 chat-provision.ts chatKvName 注释）。
    expect(cfg.kv_namespaces).toEqual([{ binding: 'SESSIONS', id: 'kv-uuid' }]);
    expect(cfg.r2_buckets).toEqual([{ binding: 'FILES', bucket_name: chatR2Name() }]);
    expect(cfg.durable_objects.bindings).toEqual([{ name: 'CHANNEL_ROOM', class_name: 'ChannelRoom' }]);
    expect(cfg.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['ChannelRoom'] }]);
    expect(cfg.assets).toMatchObject({ directory: 'chat/assets/frontend', binding: 'ASSETS', run_worker_first: true });
    expect(cfg.vars).toMatchObject({
      MODULE_ID: 'chat',
      ADMIN_USERNAMES: 'admin',
      MAX_FILE_SIZE: '20971520',
      CORE_JWKS_JSON: '{"keys":[]}',
    });
  });

  it('同输入字节级一致（确定性 = 幂等前提）；domain 空 → 无 routes', () => {
    expect(chatWranglerConfig(base)).toBe(chatWranglerConfig(base));
    const cfg = JSON.parse(chatWranglerConfig({ ...base, config: { ...base.config, domain: '' } })) as Record<string, unknown>;
    expect(cfg.routes).toBeUndefined();
  });
});

describe('moduleWorkerEntry（模块入口解析，#219）', () => {
  const REPO = new URL('../../../..', import.meta.url).pathname;

  it('hello：包 main = src/index.ts；chat：包 main = worker/src/index.js', async () => {
    await expect(moduleWorkerEntry(join(REPO, 'modules/hello'))).resolves.toBe(join(REPO, 'modules/hello/src/index.ts'));
    await expect(moduleWorkerEntry(join(REPO, 'modules/chat'))).resolves.toBe(join(REPO, 'modules/chat/worker/src/index.js'));
  });

  it('无 package.json → 回退 src/index.ts；main 指向不存在文件 → 人话报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entry-'));
    await expect(moduleWorkerEntry(dir)).resolves.toBe(join(dir, 'src/index.ts'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ main: 'nowhere.js' }));
    await expect(moduleWorkerEntry(dir)).rejects.toThrow(/main 指向的文件不存在/);
    await rm(dir, { recursive: true, force: true });
  });
});
