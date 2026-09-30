// SPDX-License-Identifier: AGPL-3.0-only

/**
 * chat shared 迁移集基线守护（#310）：
 * migrations/chat-shared/0001_baseline.sql 是 migrations/chat/0001_baseline.sql 的
 * 机械派生——18 张逻辑表全部落到 `chat_` 前缀的物理表，索引/触发器同理，供
 * storage=shared 落点与同库其他模块隔离。
 *
 * 这里用真 SQLite（node:sqlite，Node≥22 内置）直接加载 SQL 断言事实，不做字符串匹配：
 * - 派生真值来自**另一个独立产物**（chat/0001_baseline.sql 真建库后的表集），
 *   不与被测文件共用同一份常量，避免「拿 fixture 自证 fixture」；
 * - 外键用 DML 反证（指向幻影表时真 D1/SQLite 在写入瞬间才报错，只看 DDL 抓不到）。
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** shared 落点基线（被测对象）。 */
const SHARED_SCHEMA_PATH = fileURLToPath(
  new URL('../migrations/chat-shared/0001_baseline.sql', import.meta.url),
);

/** 派生源：dedicated 落点基线（逻辑表名真值）。 */
const LEGACY_SCHEMA_PATH = fileURLToPath(
  new URL('../migrations/chat/0001_baseline.sql', import.meta.url),
);

/** #310 硬口径：shared 物理表集固定 18 张。 */
const EXPECTED_TABLE_COUNT = 18;

/** shared 物理表名前缀。 */
const SHARED_PREFIX = 'chat_';

function openSchema(path: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(path, 'utf8'));
  return db;
}

/** 建表清单（排除 sqlite 内部表）。 */
function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row['name']));
}

/** 全部外键边：{ from: 引用方表, target: 被引用表 }。 */
function foreignKeyTargets(db: DatabaseSync, tables: string[]): Array<{ from: string; target: string }> {
  const edges: Array<{ from: string; target: string }> = [];
  for (const table of tables) {
    for (const fk of db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table)) {
      edges.push({ from: table, target: String(fk['table']) });
    }
  }
  return edges;
}

describe('chat shared 迁移集（chat_ 前缀基线）', () => {
  it('整份 SQL 可执行，建出 18 张表且全部以 chat_ 开头', () => {
    const db = openSchema(SHARED_SCHEMA_PATH);
    const tables = tableNames(db);
    db.close();

    expect(tables).toHaveLength(EXPECTED_TABLE_COUNT);
    expect(tables.filter((name) => !name.startsWith(SHARED_PREFIX))).toEqual([]);
  });

  it('物理表集 = dedicated 基线逻辑表名加 chat_ 前缀（机械派生对照）', () => {
    const shared = openSchema(SHARED_SCHEMA_PATH);
    const legacy = openSchema(LEGACY_SCHEMA_PATH);
    const sharedTables = tableNames(shared);
    const legacyTables = tableNames(legacy);
    shared.close();
    legacy.close();

    // 派生源本身就应是 18 张（源被改小/改大时先在这里红）
    expect(legacyTables).toHaveLength(EXPECTED_TABLE_COUNT);
    expect([...sharedTables].sort()).toEqual(
      legacyTables.map((name) => `${SHARED_PREFIX}${name}`).sort(),
    );
  });

  it('不存在未加前缀的旧表名（逻辑表名不得在 shared 库裸露）', () => {
    const shared = openSchema(SHARED_SCHEMA_PATH);
    const legacy = openSchema(LEGACY_SCHEMA_PATH);
    const sharedTables = new Set(tableNames(shared));
    const legacyTables = tableNames(legacy);
    shared.close();
    legacy.close();

    const leaked = legacyTables.filter((name) => sharedTables.has(name));
    expect(leaked).toEqual([]);
  });

  it('所有外键目标都落在 18 张 chat_ 前缀表内，且外键在图内有可达目标', () => {
    const db = openSchema(SHARED_SCHEMA_PATH);
    const tables = tableNames(db);
    const tableSet = new Set(tables);
    const edges = foreignKeyTargets(db, tables);
    db.close();

    // 非空守卫：DDL 若整体丢掉 FOREIGN KEY，下面的空集断言会假绿
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.filter((edge) => !tableSet.has(edge.target))).toEqual([]);
    expect(edges.every((edge) => edge.target.startsWith(SHARED_PREFIX))).toBe(true);
  });

  it('外键指向真实前缀表：越界 channel_id 写入被真 SQLite 拒绝', () => {
    const db = openSchema(SHARED_SCHEMA_PATH);
    // PRAGMA foreign_keys 在基线文件内已置 ON；此处真写入验证指向的是前缀表而非幻影表。
    // 选 chat_channel_pins：除外键外无 CHECK / 触发器干扰，报错必然来自 FK 解析。
    expect(() =>
      db.prepare('INSERT INTO chat_channel_pins (channel_id, message_id) VALUES (999999, 999999)').run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('逐条幂等：同库重复执行整份 SQL 不报错、表集不变', () => {
    const db = new DatabaseSync(':memory:');
    const sql = readFileSync(SHARED_SCHEMA_PATH, 'utf8');
    db.exec(sql);
    const first = tableNames(db);
    db.exec(sql);
    const second = tableNames(db);
    db.close();

    expect(second).toEqual(first);
    expect(second).toHaveLength(EXPECTED_TABLE_COUNT);
  });
});
