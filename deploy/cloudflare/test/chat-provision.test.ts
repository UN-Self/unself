// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 装配单元行为测试（#219）：
 * - ensureChatResources：chat 专属 D1/KV 查漏补建 + 撞车回查自愈；
 * - parseKvNamespaceList/parseKvCreateId：wrangler v4 真实输出形状；
 * - generateChatKeyring：AES-256 密钥环形状（worker encryption.js 可解析）；
 * - readChatPackageConfig：包配置解析 + 形状人话报错；
 * - chatWranglerConfig：/m/chat/* 路由、D1/KV/R2/DO 绑定、vars 直通、确定性（字节级一致）；
 * - moduleWorkerEntry：包 main 入口解析（hello=src/index.ts、chat=worker/src/index.js）。
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_DB_NAME,
  CHAT_KV_NAME,
  CHAT_R2_NAME,
  chatWranglerConfig,
  ensureChatResources,
  generateChatKeyring,
  parseKvCreateId,
  parseKvNamespaceList,
  readChatPackageConfig,
} from '../src/chat-provision';
import { moduleWorkerEntry } from '../src/assemble';
import type { UnselfConfig } from '../src/config';
import type { Wrangler } from '../src/wrangler';

/** chat 专属资源 fake：D1/KV 账户状态 + 命令录制（幂等断言用）。 */
function makeFake(options?: { existingD1?: string[]; existingKv?: string[] }) {
  const state = {
    d1: new Set(options?.existingD1 ?? []),
    kv: new Set(options?.existingKv ?? []),
    commands: [] as string[],
  };
  const dbId = 'b1b2c3d4-0000-0000-0000-0000000000c4';
  const kvId = 'd1d2e3f4-0000-0000-0000-0000000000d5';
  const exec = async (args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> => {
    state.commands.push(args.join(' '));
    const [cmd, sub, op] = args;
    if (cmd === 'd1') {
      if (sub === 'list') {
        return ok(JSON.stringify([...state.d1].map((name) => ({ name, uuid: dbId }))));
      }
      if (sub === 'create') {
        const name = args[2]!;
        if (state.d1.has(name)) return fail(`already exists: ${name}`);
        state.d1.add(name);
        return ok(JSON.stringify([{ name, uuid: dbId }]));
      }
    }
    if (cmd === 'kv' && sub === 'namespace') {
      if (op === 'list') {
        return ok(
          JSON.stringify([...state.kv].map((title) => ({ id: kvId, title }))),
        );
      }
      if (op === 'create') {
        const title = args[3]!;
        if (state.kv.has(title)) return fail(`namespace already exists: ${title}`);
        state.kv.add(title);
        // wrangler v4 真实输出：banner + 🎉 + snippet（id 混在文本里）
        return ok(
          `🌀 Creating namespace with title "${title}"\n✨ Success!\n` +
            `Add the following to your configuration file in your kv_namespaces block:\n[[kv_namespaces]]\nbinding = "SESSIONS"\nid = "${kvId}"\n`,
        );
      }
    }
    return ok('');
  };
  const wrangler: Wrangler = { run: exec, tryRun: exec };
  return { wrangler, state, dbId, kvId };
}
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr: string) => ({ ok: false, code: 1, stdout: '', stderr: '' });

describe('parseKvNamespaceList / parseKvCreateId（wrangler v4 真实形状）', () => {
  it('JSON 数组 [{id,title}] → NamedId[]（容忍日志前缀）', () => {
    const out = '⛅️ wrangler v4.129.0\n[\n  { "id": "abc", "title": "unself-chat-sessions" }\n]';
    expect(parseKvNamespaceList(out)).toEqual([{ name: 'unself-chat-sessions', uuid: 'abc' }]);
  });

  it('空输出 / 非 JSON → []（不误判存在）', () => {
    expect(parseKvNamespaceList('')).toEqual([]);
    expect(parseKvNamespaceList('no json here')).toEqual([]);
    expect(parseKvNamespaceList('[{"id":"x"}]')).toEqual([]);
  });

  it('create 输出混文本抓 36 位 uuid', () => {
    const out = '🌀 Creating namespace with title "t"\n✨ Success!\nid = "d1d2e3f4-0000-0000-0000-0000000000d5"\n';
    expect(parseKvCreateId(out)).toBe('d1d2e3f4-0000-0000-0000-0000000000d5');
    expect(parseKvCreateId('nothing here')).toBeNull();
  });
});

describe('ensureChatResources（查漏补建 + 撞车自愈）', () => {
  it('空账户：D1/KV 各建一次，命令形状正确，id 返回', async () => {
    const fake = makeFake();
    const logs: string[] = [];
    const { dbId, kvId } = await ensureChatResources(fake.wrangler, (m) => logs.push(m));
    expect(dbId).toBe(fake.dbId);
    expect(kvId).toBe(fake.kvId);
    expect(fake.state.commands).toContain('d1 create unself-chat');
    expect(fake.state.commands).toContain('kv namespace create unself-chat-sessions');
    expect(fake.state.commands.some((c) => c.startsWith('d1 list'))).toBe(true);
    expect(fake.state.commands.some((c) => c.startsWith('kv namespace list'))).toBe(true);
    expect(logs.some((l) => l.includes(CHAT_DB_NAME))).toBe(true);
  });

  it('已存在：零 create（幂等），list 命中直接返回 id', async () => {
    const fake = makeFake({ existingD1: [CHAT_DB_NAME], existingKv: [CHAT_KV_NAME] });
    await ensureChatResources(fake.wrangler, () => {});
    expect(fake.state.commands.some((c) => c.startsWith('d1 create'))).toBe(false);
    expect(fake.state.commands.some((c) => c.startsWith('kv namespace create'))).toBe(false);
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
  const REPO = new URL('../../..', import.meta.url).pathname;

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

  it('缺 schema-baseline.sql / D1 绑定形状不对 → 人话报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-pkg-'));
    await mkdir(join(dir, 'worker'), { recursive: true });
    await writeFile(join(dir, 'wrangler.jsonc'), '{"d1_databases":[]}');
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/形状不符/);
    await writeFile(join(dir, 'wrangler.jsonc'), '{"d1_databases":[{"binding":"DB","database_id":"x"}],"kv_namespaces":[{"binding":"OTHER","id":"y"}]}');
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/kv_namespaces/);
    await writeFile(join(dir, 'wrangler.jsonc'), '{"d1_databases":[{"binding":"DB"}],"kv_namespaces":[{"binding":"SESSIONS"}]}');
    await expect(readChatPackageConfig(dir)).rejects.toThrow(/schema-baseline/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('chatWranglerConfig（部署配置生成）', () => {
  const base = {
    config: { domain: 'team.example.com', modules: ['chat'], storage: { provider: 'r2', bucket: 'unself-storage' } } as UnselfConfig,
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
    expect(cfg.d1_databases).toEqual([{ binding: 'DB', database_name: CHAT_DB_NAME, database_id: 'chat-uuid' }]);
    // #231：SESSIONS KV 已无 worker 写入/读取方（本地会话下架 + PATCH profile 停写），
    // 绑定暂由生成配置代持到 M3 清退（取舍见 chat-provision.ts CHAT_KV_NAME 注释）。
    expect(cfg.kv_namespaces).toEqual([{ binding: 'SESSIONS', id: 'kv-uuid' }]);
    expect(cfg.r2_buckets).toEqual([{ binding: 'FILES', bucket_name: CHAT_R2_NAME }]);
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
  const REPO = new URL('../../..', import.meta.url).pathname;

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
