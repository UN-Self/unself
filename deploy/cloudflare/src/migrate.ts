// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 模块迁移与四级数据落点（#248，决策 #55/#61/#74）：
 *
 * 四级落点（storage.declaration，用户安装时选定）：
 * - core      ：数据经 Core API 代理（/api/module-api/storage/* 四形状），无模块建表，无迁移；
 * - shared    ：共享 modules 库自建表——独立记账表（#55 护栏①）+ tables 申报（护栏②）
 *               + 命名/跨模块外键硬校验（护栏③）；
 * - dedicated ：装配器供给独立 D1（`unself-<模块id>`），记账迁移照跑；
 * - external  ：自备外部库，装配器只声明不接线（连接串走配置页）。
 *
 * 失败处理（#61 硬）：停住并指出「模块 / 文件 / 第几条语句」，不自动重试、不自动回滚。
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tableNamesFromSql, splitSqlStatements } from '@unself/contracts';
import type { ModuleManifest } from '@unself/contracts';

/** 数据四级（决策 #55）。 */
export type StorageLevel = 'core' | 'shared' | 'dedicated' | 'external';

/** 模块存储决定（装配输入）：declaration 缺省 = preferred ?? core。 */
export function storageLevelFor(mod: { manifest?: ModuleManifest; id: string }): StorageLevel {
  const declared = mod.manifest?.storage?.declaration;
  if (declared) return declared;
  const preferred = mod.manifest?.storage?.preferred;
  return preferred ?? 'core';
}

/** dedicated 独立库名（chat 普通化后同规：unself-<模块id>）。 */
export function dedicatedDbNameFor(moduleId: string): string {
  return `unself-${moduleId}`;
}

/** shared 护栏③：表名必须以 `<模块id>_` 开头（下划线连写；模块 id 内的 - 转 _）。 */
export function tablePrefixFor(moduleId: string): string {
  return `${moduleId.replaceAll('-', '_')}_`;
}

/**
 * shared 护栏③硬校验（装配时执行，违者停住）：
 * - 迁移建的每张表必须以 `<模块id>_` 前缀命名；
 * - 禁止跨模块外键：FOREIGN KEY 引用的表只能是本模块申报清单内的表。
 */
export function checkSharedGuards(input: {
  moduleId: string;
  tables: string[];
  migrations: Array<{ name: string; sql: string }>;
}): string[] {
  const problems: string[] = [];
  const prefix = tablePrefixFor(input.moduleId);
  const declared = new Set(input.tables);

  for (const file of input.migrations) {
    // ① 前缀硬校验：CREATE TABLE 的表名必须带模块前缀
    for (const name of tableNamesFromSql(file.sql)) {
      if (!name.startsWith(prefix)) {
        problems.push(
          `${input.moduleId} / ${file.name}：表 ${name} 不带模块前缀 ${prefix}（shared 护栏③，docs/modules.md §6 规则3）`,
        );
      }
      if (!declared.has(name)) {
        problems.push(
          `${input.moduleId} / ${file.name}：表 ${name} 不在 tables 申报清单内（护栏②「共享库不接收未经申报的表」）`,
        );
      }
    }
    // ② 跨模块外键硬校验：FOREIGN KEY … REFERENCES <表> 只允许指向本模块申报的表
    const refs = foreignKeyTargets(file.sql);
    for (const ref of refs) {
      if (!declared.has(ref)) {
        problems.push(
          `${input.moduleId} / ${file.name}：外键引用了清单之外的表 ${ref}（禁止跨模块外键，护栏③）`,
        );
      }
    }
  }
  return problems;
}

/** 抓 FOREIGN KEY … REFERENCES 的目标表名（容忍引号与大小写）。 */
export function foreignKeyTargets(sql: string): string[] {
  const names = new Set<string>();
  const re = /REFERENCES\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;
  for (const m of sql.matchAll(re)) {
    names.add(m[1]!);
  }
  return [...names];
}

/** 读目录下 .sql 文件（文件名升序；记账契约：000N_描述.sql 只增不改）。 */
export async function readSqlFiles(dir: string): Promise<Array<{ name: string; sql: string }>> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const files: Array<{ name: string; sql: string }> = [];
  for (const name of names) {
    files.push({ name, sql: await readFile(join(dir, name), 'utf8') });
  }
  return files;
}

/** 迁移模块目录：migrations/<模块id>/（包布局 §2；包根直放形态由 module-sources 兼容）。 */
export function migrationDirFor(moduleDir: string, moduleId: string): string {
  return join(moduleDir, 'migrations', moduleId);
}

/**
 * 失败定位（#61）：把「文件内第 N 条语句」翻译成模块级人话错误并抛出。
 * 语句序号与 @unself/contracts 的 splitSqlStatements 同一切分（防两张皮）。
 */
export function migrationFailure(input: { moduleId: string; file: string; sql: string; cause: unknown }): Error {
  const statements = splitSqlStatements(input.sql);
  const raw = input.cause instanceof Error ? input.cause.message : String(input.cause);
  // 在失败语句附近找线索：错误消息里的关键词命中哪条语句（如 near "xxx"）
  let index = -1;
  const near = /near\s+["'`]?([A-Za-z0-9_]+)/i.exec(raw)?.[1];
  if (near) {
    index = statements.findIndex((s) => new RegExp(`\\b${near}\\b`, 'i').test(s));
  }
  if (index < 0) {
    for (let i = 0; i < statements.length; i++) {
      const head = statements[i]!.slice(0, 20);
      if (head.length > 0 && raw.includes(head)) {
        index = i;
        break;
      }
    }
  }
  const where = index >= 0 ? `第 ${index + 1} 条语句` : `第 ? 条语句（共 ${statements.length} 条）`;
  const detail = index >= 0 ? `\n  语句原文：${statements[index]!.slice(0, 120)}` : '';
  return new Error(
    `迁移失败（停住，不自动重试/不回滚）：模块 ${input.moduleId} / 文件 ${input.file} / ${where}\n` +
      `  原因：${raw}${detail}\n` +
      `  修复：改好迁移文件（只增不改规则适用于已应用文件；新库直接重建）后重跑装配`,
  );
}
