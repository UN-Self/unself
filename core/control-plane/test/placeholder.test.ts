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

  it('? 后面不是数字时原样保留（jsonb 的 ? 操作符不被误改）', () => {
    expect(toPgPlaceholders("SELECT data ? 'k' FROM t WHERE a = ?1")).toBe("SELECT data ? 'k' FROM t WHERE a = $1");
  });
});
