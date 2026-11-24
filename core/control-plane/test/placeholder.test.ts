// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `?N` → `$N` 占位符改写边界（#360）：只在 PG 执行器边界使用，SQL 原文不动。
 * 关键边界：字符串含 ?、注释含 ?、同一 ?N 多处引用（REGISTRY_UPSERT_SQL 的实际形态）。
 */
import { describe, expect, it } from 'vitest';
import { toPgPlaceholders } from '../src/placeholder';

describe('toPgPlaceholders（?N → $N）', () => {
  it('序号占位符逐个改写', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ?1 AND b = ?2')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('同一 ?N 多处引用全部改写（REGISTRY_UPSERT_SQL 形态：?5 出现两次，bind 仍是 8 个）', () => {
    expect(toPgPlaceholders("coalesce(?5, 'direct') ... coalesce(?5, mode)")).toBe(
      "coalesce($5, 'direct') ... coalesce($5, mode)",
    );
  });

  it('字符串字面量里的 ? 不改（含 ?N 与 单引号转义）', () => {
    expect(toPgPlaceholders("SELECT 'a?b', 'it''s ?1' WHERE x = ?1")).toBe(
      "SELECT 'a?b', 'it''s ?1' WHERE x = $1",
    );
  });

  it('双引号标识符里的 ? 不改', () => {
    expect(toPgPlaceholders('SELECT "col?1" FROM t WHERE a = ?1')).toBe('SELECT "col?1" FROM t WHERE a = $1');
  });

  it('行注释与块注释里的 ? 不改（块注释支持嵌套）', () => {
    expect(toPgPlaceholders('-- ?1\nSELECT ?2 /* ?3 /* ?4 */ ?5 */ FROM t')).toBe(
      '-- ?1\nSELECT $2 /* ?3 /* ?4 */ ?5 */ FROM t',
    );
  });

  it('匿名 ? 按出现顺序编号（workbench 路由层内联 SQL 的写法，#360 用户定案走 adapter）', () => {
    expect(toPgPlaceholders('SELECT mode FROM module_registry WHERE id = ?')).toBe(
      'SELECT mode FROM module_registry WHERE id = $1',
    );
    expect(toPgPlaceholders('UPDATE t SET a = ?, b = ? WHERE id = ?')).toBe('UPDATE t SET a = $1, b = $2 WHERE id = $3');
  });

  it('匿名 ? 与 ?N 混用：匿名从本句已有最大编号之后接起（SQLite 语义：匿名 ? = 此前最大编号 + 1）', () => {
    // `WHERE a = ? AND b = ?2` 在 SQLite 里 a 绑的是第 3 个参数；改写成 $3 才不与 $2 撞车
    expect(toPgPlaceholders('WHERE a = ? AND b = ?2')).toBe('WHERE a = $3 AND b = $2');
    expect(toPgPlaceholders('SELECT ?1, ?5, ?5, ?')).toBe('SELECT $1, $5, $5, $6');
  });

  it('字符串 / 标识符 / 注释里的 ? 不是占位符：匿名编号不受它们干扰', () => {
    expect(toPgPlaceholders("UPDATE x SET s = 'a?b' WHERE id = ? -- c?d\nAND y = ?")).toBe(
      "UPDATE x SET s = 'a?b' WHERE id = $1 -- c?d\nAND y = $2",
    );
    expect(toPgPlaceholders('SELECT "weird?col" FROM t WHERE id = ?')).toBe('SELECT "weird?col" FROM t WHERE id = $1');
    expect(toPgPlaceholders('SELECT 1 /* a ? b /* c ? */ d ? */ WHERE id = ?')).toBe(
      'SELECT 1 /* a ? b /* c ? */ d ? */ WHERE id = $1',
    );
  });

  it('? 后紧跟非空白（jsonb 的 ?| / ?& 操作符）不是占位符，原样保留', () => {
    expect(toPgPlaceholders("SELECT data ?| array['a'] FROM t WHERE id = ?")).toBe(
      "SELECT data ?| array['a'] FROM t WHERE id = $1",
    );
  });

  it('契约边界：裸 `? 值`（jsonb 存在操作符 `data ? \'k\'`）不识别，视为占位符——core 列全是 TEXT，不用 jsonb 操作符', () => {
    // 文本层面「匿名占位符」与「jsonb 二元 ?」无法可靠区分；按本仓实际用法取占位符语义，
    // 并在此把这条边界写成明文而不是让 adapter 去猜。（本句已有 ?1，匿名从 2 接起。）
    expect(toPgPlaceholders("SELECT data ? 'k' FROM t WHERE a = ?1")).toBe(
      "SELECT data $2 'k' FROM t WHERE a = $1",
    );
  });
});
