// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';

import { createD1Storage } from '../src/storage';
import { createModuleDb, type ModuleTestDb } from './test-factory';

/**
 * #9 / 审核 T8（#60）：手搓假 D1 换成真 SQLite（node:sqlite + 真 module_kv 迁移）。
 * 假替身（MemoryStatement/MemoryDatabase）只按字符串 includes 解释 createD1Storage
 * 发出的固定 SQL 形态——SQL 漏 WHERE module_id 过滤、LIKE/ESCAPE 写偏都能全绿。
 * 真库裁决后：LIKE/ESCAPE 语义由 SQLite 给出真值，并新增 T8 守护用例
 * （漏 module_id 过滤即红，见「T8 守护」组）。
 */
describe('createD1Storage（真 SQLite）', () => {
  const OPEN: ModuleTestDb[] = [];
  const makeDb = (): ModuleTestDb => {
    const db = createModuleDb();
    OPEN.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of OPEN) db.close();
    OPEN.length = 0;
  });

  const hello = (db: ModuleTestDb) => createD1Storage({ db: db.d1, moduleId: 'hello' });

  it('get 在键不存在时返回 null', async () => {
    await expect(hello(makeDb()).get('counter')).resolves.toBeNull();
  });

  it('put/get/delete/list 正常路径', async () => {
    const db = makeDb();
    const storage = hello(db);
    await storage.put('counter', '1');
    await expect(storage.get('counter')).resolves.toBe('1');
    await expect(storage.list()).resolves.toEqual(['counter']);
    await storage.delete('counter');
    await expect(storage.get('counter')).resolves.toBeNull();
    await expect(storage.list()).resolves.toEqual([]);
  });

  it('put 覆盖写（真 PK 上的 upsert：ON CONFLICT 命中才覆盖）', async () => {
    const storage = hello(makeDb());
    await storage.put('counter', '1');
    await storage.put('counter', '2');
    await expect(storage.get('counter')).resolves.toBe('2');
    await expect(storage.list()).resolves.toEqual(['counter']);
  });

  it('delete 幂等（不存在也成功）', async () => {
    const storage = hello(makeDb());
    await storage.put('counter', '1');
    await storage.delete('counter');
    await expect(storage.delete('counter')).resolves.toBeUndefined();
  });

  it('list(prefix) 前缀过滤、按键排序，空 prefix 等价全量', async () => {
    const storage = hello(makeDb());
    await storage.put('a/1', 'x');
    await storage.put('b/2', 'y');
    await storage.put('a/3', 'z');
    await expect(storage.list()).resolves.toEqual(['a/1', 'a/3', 'b/2']);
    await expect(storage.list('')).resolves.toEqual(['a/1', 'a/3', 'b/2']);
    await expect(storage.list('a')).resolves.toEqual(['a/1', 'a/3']);
    await expect(storage.list('b')).resolves.toEqual(['b/2']);
    await expect(storage.list('none')).resolves.toEqual([]);
  });

  it('list 的前缀 LIKE 按字面处理通配符（% 与 _ 不生效）——真 SQLite 裁决', async () => {
    const storage = hello(makeDb());
    await storage.put('v%', 'pct');
    await storage.put('v_', 'under');
    await storage.put('vx', 'plain');
    // ORDER BY key 下 'v%'(0x25) < 'v_'(0x5F) < 'vx'，与 ASCII 排序一致
    await expect(storage.list('v')).resolves.toEqual(['v%', 'v_', 'vx']);
    // ESCAPE '\'：% 与 _ 在任意位置都只匹配字面量（含前缀 '%'、'_' 字面查询）
    await expect(storage.list('v%')).resolves.toEqual(['v%']);
    await expect(storage.list('v_')).resolves.toEqual(['v_']);
  });

  it('跨前缀 key 一律抛错：other:xxx / evil:: / 自带本模块前缀 / 空 key', async () => {
    const storage = hello(makeDb());
    await expect(storage.put('other:xxx', '1')).rejects.toThrow('跨前缀访问');
    await expect(storage.put('evil::', '1')).rejects.toThrow('跨前缀访问');
    await expect(storage.put('hello:counter', '1')).rejects.toThrow('跨前缀访问');
    await expect(storage.get('chat:msg')).rejects.toThrow('跨前缀访问');
    await expect(storage.delete('chat:msg')).rejects.toThrow('跨前缀访问');
    await expect(storage.list('chat:')).rejects.toThrow('跨前缀访问');
    await expect(storage.put('', '1')).rejects.toThrow('非空');
  });

  it('拒绝后不留脏数据', async () => {
    const storage = hello(makeDb());
    await storage.put('counter', '1');
    await expect(storage.put('other:xxx', '2')).rejects.toThrow('跨前缀访问');
    await expect(storage.list()).resolves.toEqual(['counter']);
  });

  it('不同 moduleId 互不可见（同库并存）', async () => {
    const db = makeDb();
    const a = createD1Storage({ db: db.d1, moduleId: 'mod-a' });
    const b = createD1Storage({ db: db.d1, moduleId: 'mod-b' });
    await a.put('shared', 'a-value');
    await b.put('shared', 'b-value');
    await expect(a.get('shared')).resolves.toBe('a-value');
    await expect(b.get('shared')).resolves.toBe('b-value');
    await expect(a.list()).resolves.toEqual(['shared']);
    await expect(b.list()).resolves.toEqual(['shared']);
    await b.delete('shared');
    await expect(a.get('shared')).resolves.toBe('a-value');
    await expect(b.get('shared')).resolves.toBeNull();
  });

  it('非法 moduleId / 表名在创建时抛错', () => {
    expect(() => createD1Storage({ db: makeDb().d1, moduleId: '' })).toThrow('非法 moduleId');
    expect(() => createD1Storage({ db: makeDb().d1, moduleId: 'has space' })).toThrow('非法 moduleId');
    expect(() =>
      createD1Storage({ db: makeDb().d1, moduleId: 'hello', table: 'x; DROP TABLE module_kv' }),
    ).toThrow('非法表名');
    expect(() =>
      createD1Storage({ db: makeDb().d1, moduleId: 'hello', table: 'module-kv' }),
    ).toThrow('非法表名');
  });

  it('自定义表名可用（先在建真库建表再经 SDK 使用）', async () => {
    const db = makeDb();
    db.run(
      'CREATE TABLE mod_kv_2 (module_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(module_id, key))',
    );
    const storage = createD1Storage({ db: db.d1, moduleId: 'hello', table: 'mod_kv_2' });
    await storage.put('k', 'v');
    await expect(storage.get('k')).resolves.toBe('v');
    await expect(storage.list()).resolves.toEqual(['k']);
  });

  describe('T8 守护：真库裁决 SDK SQL（漏 WHERE module_id 即红）', () => {
    it('同 key 两模块直插后：list 只回本模块 key、get 只回本模块值', async () => {
      const db = makeDb();
      // 直插两模块同 key 行（不经 SDK，绕开子域收口，模拟真库共存数据）
      db.run(
        "INSERT INTO module_kv (module_id, key, value) VALUES ('mod-a','k','a'),('mod-b','k','b')",
      );
      const a = createD1Storage({ db: db.d1, moduleId: 'mod-a' });
      // listSql 若漏 WHERE module_id → 两行都回（['k','k']），此断言必红
      await expect(a.list()).resolves.toEqual(['k']);
      // selectSql（get）若漏 WHERE module_id → 命中 mod-b 行（'b'），此断言必红
      await expect(a.get('k')).resolves.toBe('a');
    });

    it("真建表列：columns()==['module_id','key','value']，SELECT * 行结构与之一致", async () => {
      const db = makeDb();
      expect(db.columns('module_kv')).toEqual(['module_id', 'key', 'value']);
      db.run("INSERT INTO module_kv (module_id, key, value) VALUES ('mod-a','k','a')");
      const row = db.first('SELECT * FROM module_kv');
      expect(Object.keys(row ?? {})).toEqual(db.columns('module_kv'));
    });

    it('真 PK 约束：同 (module_id,key) 二次裸 INSERT 抛错（upsert 才允许覆盖）', async () => {
      const db = makeDb();
      db.run("INSERT INTO module_kv (module_id, key, value) VALUES ('mod-a','k','a')");
      expect(() =>
        db.run("INSERT INTO module_kv (module_id, key, value) VALUES ('mod-a','k','dup')"),
      ).toThrow();
      // 首次写入的行未被破坏
      expect(
        db.first<{ value: string }>(
          'SELECT value FROM module_kv WHERE module_id = ? AND key = ?',
          'mod-a',
          'k',
        )?.value,
      ).toBe('a');
    });
  });
});
