// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 单一 SQL 标识符解析边界（#310 主会话实测退回）：
 * - SQLite 三种引号标识符 `[x]` / `"x"` / `` `x` ``；
 * - 注释夹在关键字与标识符之间；
 * - 字符串字面量/注释里的伪 REFERENCES / CREATE 不得误报。
 * 与真 SQLite（node:sqlite）对照见 validate.test.ts 的 `真库对照` 组。
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { foreignKeyTargets, stripSqlNoise, tableNamesFromSql } from '../src/sql-tables';

describe('tableNamesFromSql 标识符边界', () => {
  it('括号引号建表名不再被误认成 IF', () => {
    expect(tableNamesFromSql('CREATE TABLE IF NOT EXISTS [foreign_table] (id INTEGER);')).toEqual([
      'foreign_table',
    ]);
  });

  it('双引号 / 反引号 / 裸标识符都识别', () => {
    expect(tableNamesFromSql('CREATE TABLE "a" (id INTEGER);')).toEqual(['a']);
    expect(tableNamesFromSql('CREATE TABLE `b` (id INTEGER);')).toEqual(['b']);
    expect(tableNamesFromSql('CREATE TABLE c (id INTEGER);')).toEqual(['c']);
    expect(tableNamesFromSql('CREATE TABLE IF NOT EXISTS d (id INTEGER);')).toEqual(['d']);
  });

  it('注释夹在 CREATE TABLE 与表名之间也识别', () => {
    expect(tableNamesFromSql('CREATE TABLE IF NOT EXISTS /* c */ [t] (id INTEGER);')).toEqual(['t']);
    expect(tableNamesFromSql('CREATE TABLE -- line\n [t2] (id INTEGER);')).toEqual(['t2']);
  });

  it('字符串字面量/注释里的伪 CREATE TABLE 不误报', () => {
    expect(tableNamesFromSql("INSERT INTO t VALUES ('CREATE TABLE ghost (id INTEGER)');")).toEqual([]);
    expect(tableNamesFromSql('-- CREATE TABLE ghost (id INTEGER)')).toEqual([]);
    expect(tableNamesFromSql('/* CREATE TABLE ghost (id INTEGER) */')).toEqual([]);
  });
});

describe('foreignKeyTargets 标识符边界', () => {
  it('REFERENCES [users](id) 被抓到', () => {
    expect(foreignKeyTargets('FOREIGN KEY (x) REFERENCES [users](id)')).toEqual(['users']);
  });

  it('REFERENCES /* comment */ users(id) 被抓到', () => {
    expect(foreignKeyTargets('FOREIGN KEY (x) REFERENCES /* explanatory comment */ users(id)')).toEqual(['users']);
    expect(foreignKeyTargets('FOREIGN KEY (x) REFERENCES -- c\n users(id)')).toEqual(['users']);
  });

  it('双引号 / 反引号 / 裸目标都识别', () => {
    expect(foreignKeyTargets('REFERENCES "a"(id), REFERENCES `b`(id), REFERENCES c(id)')).toEqual(['a', 'b', 'c']);
  });

  it('字符串字面量/注释里的伪 REFERENCES 不误报', () => {
    expect(foreignKeyTargets("INSERT INTO t VALUES ('REFERENCES ghost(id)');")).toEqual([]);
    expect(foreignKeyTargets('-- REFERENCES ghost(id)')).toEqual([]);
    expect(foreignKeyTargets('/* REFERENCES ghost(id) */')).toEqual([]);
  });

  it('stripSqlNoise 保留标识符引号、清掉注释与字符串', () => {
    expect(stripSqlNoise("SELECT '[x]' /* [y] */ FROM [z]")).toContain('[z]');
    expect(stripSqlNoise("SELECT '[x]' /* [y] */ FROM [z]")).not.toContain('[y]');
  });
});

describe('真 SQLite 对照（node:sqlite 3.53.4）：括号/注释形态 SQLite 都接受并建 FK', () => {
  it('REFERENCES [users] 与 REFERENCES /* c */ users 都被 SQLite 接受，解析与真库一致', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE [users] (id INTEGER PRIMARY KEY);');
    db.exec('CREATE TABLE [t_bracket] (id INTEGER, u INTEGER REFERENCES [users](id));');
    db.exec('CREATE TABLE [t_comment] (id INTEGER, u INTEGER REFERENCES /* explanatory comment */ users(id));');
    const targets = db
      .prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('t_bracket')")
      .all() as Array<{ t: string }>;
    expect(targets.map((r) => r.t)).toEqual(['users']);
    // 解析器必须与真库同结论
    expect(foreignKeyTargets('CREATE TABLE [t_bracket] (id INTEGER, u INTEGER REFERENCES [users](id));')).toEqual(['users']);
    expect(
      foreignKeyTargets('CREATE TABLE [t_comment] (id INTEGER, u INTEGER REFERENCES /* explanatory comment */ users(id));'),
    ).toEqual(['users']);
    db.close();
  });
});
