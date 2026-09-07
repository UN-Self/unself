// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createD1Storage, type D1MinimalDatabase } from '../src/storage';

/**
 * 内存假 D1：Map 后备，实现 prepare/bind/first/all/run 最小面。
 * 只解释 createD1Storage 发出的固定 SQL 形态，不追求通用 SQL 引擎。
 */
type Row = { module_id: string; key: string; value: string };

const LIKE_ESCAPE = '\\';

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 LIKE 模式（支持 ESCAPE '\'、% 与 _）编译成正则源码。 */
function likeToSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === LIKE_ESCAPE) {
      const next = pattern[i + 1];
      if (next === undefined) {
        out += escapeRegex(LIKE_ESCAPE);
      } else {
        out += escapeRegex(next);
        i += 1;
      }
    } else if (ch === '%') {
      out += '.*';
    } else if (ch === '_') {
      out += '.';
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

class MemoryStatement {
  private params: unknown[] = [];

  constructor(
    private readonly db: MemoryDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): MemoryStatement {
    this.params = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const rows = this.select();
    if (this.sql.startsWith('SELECT value FROM')) {
      const row = rows[0];
      return row ? ({ value: row.value } as T) : null;
    }
    return (rows[0] ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.select();
    const results = this.sql.startsWith('SELECT key FROM')
      ? rows.map((row) => ({ key: row.key }) as T)
      : (rows as unknown as T[]);
    return { results };
  }

  async run(): Promise<{ success: boolean }> {
    const [moduleId, key, value] = this.params as [string, string, string | undefined];
    if (this.sql.startsWith('INSERT INTO')) {
      this.db.upsert(moduleId, key, value ?? '');
    } else if (this.sql.startsWith('DELETE FROM')) {
      this.db.remove(moduleId, key);
    }
    return { success: true };
  }

  private select(): Row[] {
    const [moduleId, firstParam] = this.params as [string, string | undefined];
    const rows = this.db.rowsOf(moduleId);
    if (this.sql.includes('key = ?') && !this.sql.includes('LIKE')) {
      return rows.filter((row) => row.key === firstParam);
    }
    if (this.sql.includes('LIKE')) {
      // list(prefix) 绑定两个参数：(moduleId, 已转义的模式+%)。
      const regex = new RegExp(`^${likeToSource(firstParam ?? '')}$`);
      return rows.filter((row) => regex.test(row.key));
    }
    return rows;
  }
}

/** Map 后备的 moduleId → key → value。 */
class MemoryDatabase implements D1MinimalDatabase {
  private readonly data = new Map<string, Map<string, string>>();

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql);
  }

  rowsOf(moduleId: string): Row[] {
    const keys = this.data.get(moduleId);
    if (!keys) {
      return [];
    }
    return [...keys]
      .map(([key, value]) => ({ module_id: moduleId, key, value }))
      // 与 D1 的 ORDER BY key 对齐（ASCII 键下同序）。
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  upsert(moduleId: string, key: string, value: string): void {
    let keys = this.data.get(moduleId);
    if (!keys) {
      keys = new Map();
      this.data.set(moduleId, keys);
    }
    keys.set(key, value);
  }

  remove(moduleId: string, key: string): void {
    this.data.get(moduleId)?.delete(key);
  }
}

describe('createD1Storage', () => {
  const makeDb = (): MemoryDatabase => new MemoryDatabase();
  const hello = (db: MemoryDatabase) => createD1Storage({ db, moduleId: 'hello' });

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

  it('put 覆盖写', async () => {
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

  it('list 的前缀 LIKE 按字面处理通配符（% 与 _ 不生效）', async () => {
    const storage = hello(makeDb());
    await storage.put('v%', 'pct');
    await storage.put('v_', 'under');
    await storage.put('vx', 'plain');
    await expect(storage.list('v')).resolves.toEqual(['v%', 'v_', 'vx']);
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
    const a = createD1Storage({ db, moduleId: 'mod-a' });
    const b = createD1Storage({ db, moduleId: 'mod-b' });
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
    expect(() => createD1Storage({ db: makeDb(), moduleId: '' })).toThrow('非法 moduleId');
    expect(() => createD1Storage({ db: makeDb(), moduleId: 'has space' })).toThrow('非法 moduleId');
    expect(() =>
      createD1Storage({ db: makeDb(), moduleId: 'hello', table: 'x; DROP TABLE module_kv' }),
    ).toThrow('非法表名');
    expect(() => createD1Storage({ db: makeDb(), moduleId: 'hello', table: 'module-kv' })).toThrow(
      '非法表名',
    );
  });

  it('自定义表名可用', async () => {
    const db = makeDb();
    const storage = createD1Storage({ db, moduleId: 'hello', table: 'mod_kv_2' });
    await storage.put('k', 'v');
    await expect(storage.get('k')).resolves.toBe('v');
  });
});
