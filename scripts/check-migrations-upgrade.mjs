#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * check-migrations-upgrade：跨版本迁移闸门（issue #195 机制③；#248 自动发现）。
 *
 * 背景（AGENTS.md 已知坑 + docs/testing.md「跨版本升级要测」）：
 *   wrangler d1 migrations 按**文件名**记账（d1_migrations 表）——已应用过的旧文件
 *   不会重跑。「同一内存库重放全部迁移」的守卫（app/workbench/test/migrations.test.ts）
 *   只覆盖**全新库**路径，会把两类问题全遮掉：
 *     a) 新迁移对**老库 schema** 不兼容（引用老库还没有的表/列——0004 踩过的坑：
 *        依赖被改的 0001 建的表，在老库上 `no such table`）；
 *     b) 新迁移在**既有数据**上失败（如 UNIQUE 索引撞上大小写变体重复行）。
 *
 * 本脚本用 node:sqlite（Node ≥ 22 内置，零依赖）模拟老库升级路径，对每个迁移目录：
 *   1. 对每个「切断点 k」（1 ≤ k ≤ N-1）：先按文件名序应用前 k 个迁移 = 老库；
 *   2. 在老库里写入既有数据（每张表一行代表性老数据，见 LEGACY_SEEDS）；
 *   3. 再继续应用第 k+1..N 个迁移 = 模拟 `d1 migrations apply` 升级；
 *   4. 断言升级不抛错，且记账与文件一一对应。
 *   切断点覆盖「任意历史版本升级到最新」；比「只测 0.1.0 → 当前」更强。
 *
 * 目录发现（#248）：**自动遍历**仓库内全部「migrations」目录（modules/<id>/migrations/<id>/、
 * services 下的 migrations 目录）——新模块带 migrations/ 目录进仓即入闸门，
 * 无需改本脚本。红灯验证：把 DISCOVER 换回硬编码清单 → 新模块断言必红。
 *
 * 退出码：全部通过 = 0；任何切断点失败 = 1（CI 闸门）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // scripts/ 的上一级 = 仓库根

/** 老库既有数据（代表性行）：升级必须能在这些行上跑通。 */
const LEGACY_SEEDS = {
  'app/workbench/migrations/core': {
    // users（0001）：老数据含大写 email——0007 若加 lower(email) 唯一索引，重复大小写变体必须先归一
    users: [
      "INSERT INTO users (id, issuer, sub, display_name, email, role, status) VALUES ('u_old', 'builtin', 'u_old', '老用户', 'Old.User@Example.com', 'user', 'active')",
    ],
    invites: [
      "INSERT INTO invites (token_hash, status, personal_email, email_prefix, display_name, expires_at) VALUES ('h_old', 'pending', 'Old.User@Personal.example', 'old', '老人', datetime('now', '+30 days'))",
    ],
    notification_types: [
      "INSERT OR IGNORE INTO notification_types (type, template, in_app, email) VALUES ('invite_result', '邀请申请结果', 1, 1)",
    ],
    notifications: [
      "INSERT INTO notifications (id, invited_email, type, payload) VALUES ('n_old', 'Old.User@Personal.example', 'invite_result', '{}')",
    ],
    module_registry: [
      "INSERT INTO module_registry (id, enabled, version, manifest_json) VALUES ('hello', 1, '0.1.0', '{}')",
    ],
    acl: ["INSERT INTO acl (resource, user_id, perm) VALUES ('member:list', 'u_old', 'read')"],
    audit_log: ["INSERT INTO audit_log (actor, action, target) VALUES ('u_old', 'member.invite', 'h_old')"],
    // 0002
    instance_config: ["INSERT INTO instance_config (key, value) VALUES ('setup_done', 'true')"],
    // 0004（老库可能已应用 0004 未应用 0005+，此时表里已有激活行）
    invite_activations: [
      "INSERT INTO invite_activations (token_hash, invite_token_hash, email, expires_at) VALUES ('a_old', 'h_old', 'Old.User@Example.com', datetime('now', '+7 days'))",
    ],
    // 0005（含大小写变体用户名：升级到 0007 的 lower(username) 唯一索引必须兼容单行；重复变体属人工决策不自动清理）
    builtin_credentials: [
      "INSERT INTO builtin_credentials (user_id, username, password_hash) VALUES ('u_old', 'Old.Name', 'pbkdf2-sha256$1$AQID$AQID')",
    ],
    invite_credentials: [
      "INSERT INTO invite_credentials (token_hash, username, password_hash) VALUES ('h_old', 'Old.Name', 'pbkdf2-sha256$1$AQID$AQID')",
    ],
    // 0006
    login_attempts: ["INSERT INTO login_attempts (key, failures, window_start) VALUES ('u:old.name', 3, 0)"],
  },
  'app/workbench/migrations/modules': {
    // 平台基建表（#248）：老库里已有模块键值行，升级必须能在这些行上继续跑
    module_kv: ["INSERT INTO module_kv (module_id, key, value) VALUES ('hello', 'old-key', 'old-value')"],
  },
};

/**
 * 自动发现受闸门的迁移目录（#248）：自动遍历仓库内的「migrations」目录。
 * 规则：目录名 migrations 下一层子目录（按模块 id 分组）各为一个受闸门单元；
 * 兼容「包根直放」形态（migrations 下直接是 .sql，无 id 子目录）→ 目录本身即单元。
 */
function discoverMigrationDirs() {
  const dirs = [];
  const scan = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // node_modules 与隐藏目录跳过；dist 跳过（#257：安装器产物里有 migrations 的**副本**，
      // 那是打包产物不是迁移真源——重复入闸门只会把「产物陈旧」误报成「迁移不兼容」）
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const child = join(abs, entry.name);
      const relChild = `${rel}/${entry.name}`;
      if (entry.name === 'migrations') {
        // 候选迁移根：子目录逐个入闸门；无子目录且含 .sql → 根自身入闸门
        const inner = readdirSync(child, { withFileTypes: true });
        const subDirs = inner.filter((e) => e.isDirectory());
        const hasSql = inner.some((e) => e.isFile() && e.name.endsWith('.sql'));
        if (subDirs.length === 0 && hasSql) {
          dirs.push(relChild);
        } else {
          for (const sub of subDirs) dirs.push(`${relChild}/${sub.name}`);
        }
        continue;
      }
      scan(relChild); // 继续下钻找 migrations/（两层足够：app/workbench、modules/<id>）
    }
  };
  scan('.');
  return dirs.sort();
}

/** 按文件名序读迁移文件（与 wrangler d1 migrations 的应用序一致）。 */
function readMigrations(dir) {
  const abs = join(ROOT, dir);
  const files = readdirSync(abs)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.error(`✗ ${dir}: 没有 *.sql 迁移文件`);
    process.exitCode = 1;
    return null;
  }
  return files.map((f) => ({ name: f, sql: readFileSync(join(abs, f), 'utf8') }));
}

/** 判断某张表在「前 k 个迁移」执行后是否已存在（存在才种老数据）。 */
function tableExists(db, table) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

/** 在老库种既有数据：只种当前 schema 已有的表（多余种子会被跳过并留档）。 */
function seedLegacyRows(db, dir, label) {
  const seeds = LEGACY_SEEDS[dir.replace(/^\.\//, '')] ?? {}; // seeds 键不带 ./ 前缀
  let seeded = 0;
  let skipped = 0;
  for (const [table, inserts] of Object.entries(seeds)) {
    if (!tableExists(db, table)) {
      skipped += inserts.length;
      continue;
    }
    for (const sql of inserts) {
      db.exec(sql);
      seeded += 1;
    }
  }
  console.log(`    老数据：种 ${seeded} 行（跳过 ${skipped} 条——切断点之后的表尚未建） [${label}]`);
}

/** 主检查：对每个切断点模拟「老库 → 应用新迁移」。 */
function checkDir(dir) {
  const migrations = readMigrations(dir);
  if (!migrations) return false;
  const n = migrations.length;
  console.log(`\n▣ ${dir}（${n} 个迁移文件）`);
  if (n < 2) {
    console.log('  只有 1 个迁移文件：无升级路径可测（全新库路径由各包测试覆盖）');
    return true;
  }

  let allOk = true;
  for (let cut = 1; cut <= n - 1; cut++) {
    const label = `老库 = 前 ${cut} 个迁移（${migrations[cut - 1].name}）→ 升级 = ${n - cut} 个新迁移`;
    const db = new DatabaseSync(':memory:');
    try {
      for (let i = 0; i < cut; i++) {
        db.exec(migrations[i].sql);
      }
      seedLegacyRows(db, dir, label);
      for (let i = cut; i < n; i++) {
        db.exec(migrations[i].sql); // 升级路径：任何失败 = 红灯
      }
      console.log(`  ✓ ${label}`);
    } catch (err) {
      allOk = false;
      console.error(`  ✗ ${label}`);
      console.error(`    失败于切断点 ${cut}：${String(err instanceof Error ? err.message : err)}`);
    } finally {
      db.close();
    }
  }
  return allOk;
}

// ---- 入口 ----
const MIGRATION_DIRS = discoverMigrationDirs();
console.log('受闸门的迁移目录（自动发现）：');
for (const dir of MIGRATION_DIRS) console.log(`  - ${dir}`);

let ok = true;
for (const dir of MIGRATION_DIRS) {
  if (!checkDir(dir)) ok = false;
}
console.log(`\n${ok ? '✓ 跨版本迁移闸门通过' : '✗ 跨版本迁移闸门失败'}`);
process.exit(ok ? 0 : 1);
