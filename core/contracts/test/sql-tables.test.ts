// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 单一 SQL 结构解析边界（#310 复验退回）：词法分 token + 语法位置认标识符。
 * 覆盖：三种引号标识符、引号内含 `--`、单引号字符串作 REFERENCES 目标（SQLite 实测接受）、
 * 注释夹关键字、字符串/注释里的伪关键字不误报、不支持语法显式拒绝，以及与真 SQLite 对照。
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { foreignKeyTargets, parseSqlStructure, tableNamesFromSql, tokenizeSql } from '../src/sql-tables';

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

  it('引号标识符里的 -- 不是行注释，不吞掉后续语句', () => {
    const sql = 'CREATE TABLE [t] ("-- not a comment" INTEGER); CREATE TABLE [u] (id INTEGER);';
    expect(tableNamesFromSql(sql)).toEqual(['t', 'u']);
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

  it('单引号字符串作 REFERENCES 目标也抓到（SQLite 实测接受）', () => {
    expect(foreignKeyTargets("FOREIGN KEY (x) REFERENCES 'users'(id)")).toEqual(['users']);
  });

  it('双引号 / 反引号 / 裸 / schema 限定目标都识别', () => {
    expect(foreignKeyTargets('REFERENCES "a"(id), REFERENCES `b`(id), REFERENCES c(id)')).toEqual(['a', 'b', 'c']);
    expect(foreignKeyTargets('REFERENCES main.users(id)')).toEqual(['users']);
  });

  it('列名是含 -- 的双引号标识符时，其后的 REFERENCES users 仍被抓到', () => {
    const sql = 'CREATE TABLE t ("-- harmless column" INTEGER, f INTEGER REFERENCES users(id));';
    expect(foreignKeyTargets(sql)).toEqual(['users']);
  });

  it('字符串字面量/注释里的伪 REFERENCES 不误报', () => {
    expect(foreignKeyTargets("INSERT INTO t VALUES ('REFERENCES ghost(id)');")).toEqual([]);
    expect(foreignKeyTargets('-- REFERENCES ghost(id)')).toEqual([]);
    expect(foreignKeyTargets('/* REFERENCES ghost(id) */')).toEqual([]);
  });
});

describe('不支持/畸形的真实语法显式拒绝（problems 非空）', () => {
  it("CREATE TABLE 后是字符串名 → problem（不静默跳过）", () => {
    expect(parseSqlStructure("CREATE TABLE 'x' (id INTEGER);").problems.length).toBeGreaterThan(0);
  });

  it('REFERENCES 后缺目标 → problem', () => {
    expect(parseSqlStructure('CREATE TABLE t (id INTEGER, f INTEGER REFERENCES (id));').problems.length).toBeGreaterThan(0);
    expect(parseSqlStructure('CREATE TABLE t (id INTEGER REFERENCES);').problems.length).toBeGreaterThan(0);
  });

  it('CREATE TABLE IF 子句残缺 → problem', () => {
    expect(parseSqlStructure('CREATE TABLE IF x (id INTEGER);').problems.length).toBeGreaterThan(0);
  });

  it('未闭合引号/块注释 → problem', () => {
    expect(tokenizeSql("SELECT 'oops").problems.length).toBeGreaterThan(0);
    expect(tokenizeSql('SELECT /* oops').problems.length).toBeGreaterThan(0);
  });
});

describe('与真 SQLite 边界矩阵（解析结果必须与真库一致，或显式拒绝）', () => {
  interface Case {
    name: string;
    sql: string;
    support: boolean;
  }
  const cases: Case[] = [
    { name: '普通建表', sql: 'CREATE TABLE todo_items (id INTEGER PRIMARY KEY);', support: true },
    { name: 'IF NOT EXISTS + 括号', sql: 'CREATE TABLE IF NOT EXISTS [todo_items] (id INTEGER PRIMARY KEY);', support: true },
    { name: '双引号/反引号', sql: 'CREATE TABLE "a" (id INTEGER); CREATE TABLE `b` (id INTEGER);', support: true },
    { name: '注释夹 CREATE/TABLE/名', sql: 'CREATE TABLE IF NOT EXISTS /* c */ [t] (id INTEGER);', support: true },
    {
      name: '单引号 REFERENCES 目标',
      sql: "CREATE TABLE [ref] (id INTEGER PRIMARY KEY); CREATE TABLE [t] (id INTEGER, f INTEGER REFERENCES 'ref'(id));",
      support: true,
    },
    {
      name: 'Unicode 标识符 REFERENCES（不得截断）',
      sql: 'CREATE TABLE [todo_items外] (id INTEGER PRIMARY KEY); CREATE TABLE [t] (id INTEGER, f INTEGER REFERENCES todo_items外(id));',
      support: true,
    },
    {
      name: '引号内含 -- 的列名 + REFERENCES',
      sql: 'CREATE TABLE [ref] (id INTEGER PRIMARY KEY); CREATE TABLE [t] ("-- harmless column" INTEGER, f INTEGER REFERENCES ref(id));',
      support: true,
    },
    {
      name: '字符串/注释里的伪关键字',
      sql: "CREATE TABLE [t] (id INTEGER); INSERT INTO t VALUES ('CREATE TABLE ghost (id INTEGER)'); -- CREATE TABLE ghost2 (id INTEGER)\n/* REFERENCES ghost3(id) */",
      support: true,
    },
    { name: '不支持：CREATE VIRTUAL TABLE（fts5 影子表）', sql: 'CREATE VIRTUAL TABLE IF NOT EXISTS foreign_search USING fts5(content);', support: false },
    { name: "不支持：CREATE TABLE 'x'（字符串名）", sql: "CREATE TABLE 'x' (id INTEGER);", support: false },
  ];

  function realStructure(sql: string): { tables: string[]; refs: string[] } {
    const db = new DatabaseSync(':memory:');
    db.exec(sql);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    const refs = new Set<string>();
    for (const t of tables) {
      const rows = db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('${t}')`).all() as Array<{ t: string }>;
      for (const r of rows) refs.add(r.t);
    }
    db.close();
    return { tables, refs: [...refs].sort() };
  }

  for (const c of cases) {
    it(`${c.name}`, () => {
      const real = realStructure(c.sql);
      const parsed = parseSqlStructure(c.sql);
      if (!c.support) {
        // 不支持的真实语法：必须显式拒绝（不静默跳过）；真库确实建了东西也说明漏检危害
        expect(parsed.problems.length).toBeGreaterThan(0);
        return;
      }
      expect(parsed.problems).toEqual([]);
      expect([...parsed.tables].sort()).toEqual(real.tables);
      expect([...parsed.references].sort()).toEqual(real.refs);
    });
  }
});

describe('真 SQLite 对照（node:sqlite 3.53.4）', () => {
  it('REFERENCES [users] / /* c */ users / 单引号 users 真库都建出 FK，解析器同结论', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE [users] (id INTEGER PRIMARY KEY);');
    db.exec('CREATE TABLE [t_bracket] (id INTEGER, u INTEGER REFERENCES [users](id));');
    db.exec('CREATE TABLE [t_comment] (id INTEGER, u INTEGER REFERENCES /* explanatory comment */ users(id));');
    db.exec("CREATE TABLE [t_squote] (id INTEGER, u INTEGER REFERENCES 'users'(id));");
    const fkOf = (t: string) =>
      (db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('${t}')`).all() as Array<{ t: string }>).map(
        (r) => r.t,
      );
    expect(fkOf('t_bracket')).toEqual(['users']);
    expect(fkOf('t_comment')).toEqual(['users']);
    expect(fkOf('t_squote')).toEqual(['users']);
    db.close();

    expect(foreignKeyTargets('CREATE TABLE [t_bracket] (id INTEGER, u INTEGER REFERENCES [users](id));')).toEqual(['users']);
    expect(
      foreignKeyTargets('CREATE TABLE [t_comment] (id INTEGER, u INTEGER REFERENCES /* explanatory comment */ users(id));'),
    ).toEqual(['users']);
    expect(foreignKeyTargets("CREATE TABLE [t_squote] (id INTEGER, u INTEGER REFERENCES 'users'(id));")).toEqual(['users']);
  });

  it('含 -- 的双引号列名真库可建，解析器仍抓到跨模块 REFERENCES', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE [users] (id INTEGER PRIMARY KEY);');
    const sql = 'CREATE TABLE [t] ("-- harmless column" INTEGER, f INTEGER REFERENCES users(id));';
    db.exec(sql);
    const fk = db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('t')`).all() as Array<{ t: string }>;
    expect(fk.map((r) => r.t)).toEqual(['users']);
    db.close();
    expect(foreignKeyTargets(sql)).toEqual(['users']);
  });
});
