-- SPDX-License-Identifier: AGPL-3.0-only
-- unself-core：module_registry.mode 三值收敛两值（issue #369）
--
-- 背景：0012 的 mode 三值（cloudflare / docker / connect）混了两根轴——前两个说的是
-- 「模块跑在哪」，connect 说的是「谁把请求送到模块」。跑在哪归 manifest.runtimes
-- （worker / node），注册表只需要回答接入方式（docs/modules.md §4）：
--   direct   有对外地址，壳把模块页当 iframe 直指过去，core 不转发
--   connect  没有对外地址，模块拨回来，core 经 /m/<id>/ 隧道转发
-- 映射：cloudflare → direct、docker → direct（两者都有对外地址，只是跑在哪不同）、
-- connect 不动。反连模块照样能跑在 docker 里（PR #367 的 hello/calendar 就是），
-- 这正是三值混轴照不出来的那类组合。
--
-- 为什么重建表而不是 UPDATE 完事：0012 把值域写进了列级 CHECK，SQLite 没有
-- ALTER COLUMN / DROP CONSTRAINT，改值域只能「新表 → 拷数据 → 换名」。新表的列集与
-- 0012–0016 逐条 ALTER 之后的真表逐列对齐（entry/storage_level/mode ← 0012、
-- credential_hash ← 0013、config_values ← 0015、lifecycle ← 0016），只换 CHECK。
--
-- entry 列语义不变：两种接入方式都有值——direct 是模块真实地址（CF 装机由系统算、
-- 自建反代由管理员填），connect 是 core 自己的 /m/<id>/。「connect 必须有 entry」的
-- CHECK 原样保留（0012 的构成定义：API 与 installer 两个写入入口各查各的，数据层兜底）。
--
-- 迁移安全性（#61 增量安全语句 + 按文件名记账）：
--   - 重建在事务里一次完成，失败整份回滚不记账，重跑整份重放；
--   - 旧表按固定名 module_registry_legacy_0017 落地，重放时先 DROP（上次成功但未记账的残留）；
--   - 0003 的索引随旧表走，新表原样重建；
--   - 记账后旧表不再存在，不会留下第二张真相表。
--
-- 实测版本：SQLite 3.54.1（node:sqlite；重建 + 数据映射 + CHECK 拒收旧值，证据见 PR）。

DROP TABLE IF EXISTS module_registry_legacy_0017;

CREATE TABLE module_registry_new (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  manifest_json TEXT NOT NULL,
  entry TEXT,
  storage_level TEXT,
  mode TEXT NOT NULL DEFAULT 'direct'
    CHECK (mode IN ('direct', 'connect') AND (mode != 'connect' OR entry IS NOT NULL)),
  credential_hash TEXT,
  config_values TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'pending'
);

INSERT INTO module_registry_new (id, enabled, version, manifest_json, entry, storage_level, mode, credential_hash, config_values, lifecycle)
SELECT
  id, enabled, version, manifest_json, entry, storage_level,
  CASE mode WHEN 'connect' THEN 'connect' ELSE 'direct' END,
  credential_hash, config_values, lifecycle
FROM module_registry;

DROP TABLE module_registry;
ALTER TABLE module_registry_new RENAME TO module_registry;

CREATE INDEX idx_module_registry_enabled ON module_registry (enabled, id);
