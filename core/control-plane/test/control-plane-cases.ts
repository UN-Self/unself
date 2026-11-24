// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ControlPlane 契约行为用例（#360）：同一段测试体跑在所有实现上（node:sqlite / PostgreSQL），
 * 不复制粘贴。执行器差异只留在 harness（seal / reset / close）。
 *
 * 两问检验：把 upsert 改成「不收敛」（如 INSERT 无 ON CONFLICT）必红；把记账表改成
 * 全局共享（同表）必红；落点三列改回覆盖式（excluded.x 直赋）必红（#348 review）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationsTableFor, type ControlPlane } from '../src/types';

const MANIFEST = { id: 'hello', version: '0.1.0', entry: '/m/hello/', runtime: 'worker' };

export interface ControlPlaneHarness {
  cp: ControlPlane;
  /** 封箱：写 instance_config.setup_done=1（各实现直写底层库）。 */
  seal(): Promise<void>;
  /** 用例间隔离（复用同一库时清表；`:memory:` 实现可为空操作）。 */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** 把契约行为用例挂到某实现上：make 每次返回干净 harness。 */
export function defineControlPlaneContract(label: string, make: () => Promise<ControlPlaneHarness>): void {
  describe(label, () => {
    let h: ControlPlaneHarness;

    beforeEach(async () => {
      h = await make();
      await h.reset();
    });

    afterEach(async () => {
      await h.close();
    });

    it('core 库不在 CF 时（全新空库）注册表与 setup token 都能写成功', async () => {
      const cp = h.cp;
      const entry = await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
      expect(entry).toMatchObject({ id: 'hello', enabled: true, version: '0.1.0' });
      const issue = await cp.issueSetupToken(() => 'tok-abc');
      expect(issue).toEqual({ status: 'created', token: 'tok-abc' });
      await expect(cp.isSetupTokenValid('tok-abc')).resolves.toBe(true);
      await expect(cp.readRegistry()).resolves.toHaveLength(1);
    });

    it('落点三列合并语义（#348 review）：未写保留旧值，显式传值覆盖；首次插入 mode 缺省 direct（#369）', async () => {
      const cp = h.cp;
      const first = await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
      expect(first).toMatchObject({ mode: 'direct', entry: null, storage_level: null });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST, storage_level: 'core', mode: 'connect', entry: 'https://bridge.example.com/m/bridge/' });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: { ...MANIFEST, version: '0.2.0' } });
      const rows = await cp.readRegistry();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: '0.2.0',
        mode: 'connect',
        entry: 'https://bridge.example.com/m/bridge/',
        storage_level: 'core',
      });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST, mode: 'direct', storage_level: 'self' });
      expect((await cp.readRegistry())[0]).toMatchObject({ mode: 'direct', entry: null, storage_level: 'self' });
    });

    it('credential_hash（#349）：合并语义同落点三列——未写保留旧值、显式传值覆盖、首插直写', async () => {
      const cp = h.cp;
      const first = await cp.upsertModule({
        id: 'hello',
        enabled: false,
        manifest: MANIFEST,
        mode: 'connect',
        entry: 'https://core.example.com/m/hello/',
        credential_hash: 'a'.repeat(64),
      });
      expect(first).toMatchObject({ credential_hash: 'a'.repeat(64) });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: { ...MANIFEST, version: '0.2.0' } });
      expect((await cp.readRegistry())[0]).toMatchObject({ enabled: true, credential_hash: 'a'.repeat(64) });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST, credential_hash: null });
      expect((await cp.readRegistry())[0]).toMatchObject({ credential_hash: 'a'.repeat(64) });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST, credential_hash: 'b'.repeat(64) });
      expect((await cp.readRegistry())[0]).toMatchObject({ credential_hash: 'b'.repeat(64) });
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST, mode: 'direct', entry: null, storage_level: 'core' });
      expect((await cp.readRegistry())[0]).toMatchObject({ mode: 'direct', entry: null, storage_level: 'core', credential_hash: 'b'.repeat(64) });
    });

    it('upsert 收敛：同 id 重复注册刷新快照不重复建行；toggle 不存在的 id 回 null', async () => {
      const cp = h.cp;
      await cp.upsertModule({ id: 'hello', enabled: true, manifest: MANIFEST });
      await cp.upsertModule({ id: 'hello', enabled: false, manifest: { ...MANIFEST, version: '0.2.0' } });
      const rows = await cp.readRegistry();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ enabled: false, version: '0.2.0' });
      await expect(cp.toggleModule('ghost', true)).resolves.toBeNull();
      await expect(cp.toggleModule('hello', true)).resolves.toMatchObject({ enabled: true });
    });

    it('setup token 三态：created → reused → sealed（封箱后绝不签发）', async () => {
      const cp = h.cp;
      await expect(cp.issueSetupToken(() => 't1')).resolves.toEqual({ status: 'created', token: 't1' });
      await expect(cp.issueSetupToken(() => 't2')).resolves.toEqual({ status: 'reused', token: 't1' });
      await h.seal();
      await expect(cp.issueSetupToken(() => 't3')).resolves.toEqual({ status: 'sealed' });
    });

    it('原子消费：并发双激活只有一次命中', async () => {
      const cp = h.cp;
      await cp.issueSetupToken(() => 'once');
      const [a, b] = await Promise.all([cp.consumeSetupToken('once', 'u1'), cp.consumeSetupToken('once', 'u2')]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      await expect(cp.consumeSetupToken('once', 'u3')).resolves.toBe(false);
    });

    it('按模块独立记账：同文件名跨模块互不可见（#55 护栏①）', async () => {
      const cp = h.cp;
      const files = [{ name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id TEXT);' }];
      const r1 = await cp.applyMigrations('alpha', files);
      expect(r1.applied).toEqual(['0001_init.sql']);
      const r2 = await cp.applyMigrations('beta', files);
      expect(r2.applied).toEqual(['0001_init.sql']);
      expect(r2.skipped).toEqual([]);
      const r3 = await cp.applyMigrations('alpha', files);
      expect(r3.applied).toEqual([]);
      expect(r3.skipped).toEqual(['0001_init.sql']);
      expect(migrationsTableFor('alpha')).toBe('unself_migrations_alpha');
      expect(migrationsTableFor('a-b')).toBe('unself_migrations_a_b');
      expect(() => migrationsTableFor('Bad!')).toThrow();
    });

    it('记账失败态：SQL 坏文件不记账，重跑整份重放（#55/modules.md 迁移契约）', async () => {
      const cp = h.cp;
      const report = await cp
        .applyMigrations('mod', [
          { name: '0001_ok.sql', sql: 'CREATE TABLE IF NOT EXISTS ok_t (id TEXT);' },
          { name: '0002_bad.sql', sql: 'THIS IS NOT SQL;' },
          { name: '0003_after.sql', sql: 'CREATE TABLE IF NOT EXISTS after_t (id TEXT);' },
        ])
        .catch(() => null);
      expect(report).toBeNull();
      const retry = await cp.applyMigrations('mod', [
        { name: '0001_ok.sql', sql: 'CREATE TABLE IF NOT EXISTS ok_t (id TEXT);' },
        { name: '0002_bad.sql', sql: 'CREATE TABLE IF NOT EXISTS fixed_t (id TEXT);' },
        { name: '0003_after.sql', sql: 'CREATE TABLE IF NOT EXISTS after_t (id TEXT);' },
      ]);
      expect(retry.applied).toEqual(['0002_bad.sql', '0003_after.sql']);
      expect(retry.skipped).toEqual(['0001_ok.sql']);
    });

    it('非 SQL 迁移事件（DO 迁移 tag）记进同一张模块记账表：跨模块不可见、重复记幂等（#255）', async () => {
      const cp = h.cp;
      await cp.applyMigrations('chat', [{ name: '0001_baseline.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id TEXT);' }]);
      await cp.markMigrationApplied('chat', 'do-migration:v1');
      await expect(cp.appliedMigrations('chat')).resolves.toEqual(['0001_baseline.sql', 'do-migration:v1']);
      await cp.markMigrationApplied('chat', 'do-migration:v1');
      await expect(cp.appliedMigrations('chat')).resolves.toEqual(['0001_baseline.sql', 'do-migration:v1']);
      await expect(cp.appliedMigrations('hello')).resolves.toEqual([]);
      const r = await cp.applyMigrations('chat', [
        { name: '0001_baseline.sql', sql: 'SELECT 1;' },
        { name: '0002_next.sql', sql: 'CREATE TABLE IF NOT EXISTS t2 (id TEXT);' },
      ]);
      expect(r.applied).toEqual(['0002_next.sql']);
      expect(r.skipped).toEqual(['0001_baseline.sql']);
    });
  });
}
