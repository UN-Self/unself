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
 *
 * #255：DO 迁移 tag 的「是否已应用」= **模块记账表里的事实**（`doMigrationLedgerName`），
 * 与「脚本是否存在」彻底解耦（planDoMigrations）。
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitSqlStatements } from '@unself/contracts';
import type { ModuleManifest } from '@unself/contracts';
import { resourceName } from './naming';

/** 数据四级（决策 #55）。 */
export type StorageLevel = 'core' | 'shared' | 'dedicated' | 'external';

/** 模块存储决定（装配输入）：declaration 缺省 = preferred ?? core。 */
export function storageLevelFor(mod: { manifest?: ModuleManifest; id: string }): StorageLevel {
  const declared = mod.manifest?.storage?.declaration;
  if (declared) return declared;
  const preferred = mod.manifest?.storage?.preferred;
  return preferred ?? 'core';
}

/** dedicated 独立库名（chat 普通化后同规：unself-<模块id>；带 UNSELF_RESOURCE_PREFIX 时随前缀，#257）。 */
export function dedicatedDbNameFor(moduleId: string): string {
  return resourceName(moduleId);
}

/**
 * DO 迁移 tag 在模块记账表里的条目名（#255）：与 SQL 文件名**同表**、不同命名空间
 * ——复用 #248 的 `unself_migrations_<模块>`，不另造第二套记账（决策 #55/#64）。
 */
export function doMigrationLedgerName(tag: string): string {
  return `do-migration:${tag}`;
}

/** 包配置里声明的 DO 迁移（wrangler migrations 数组的一项）。 */
export interface DoMigrationDeclaration {
  tag: string;
  new_sqlite_classes: string[];
}

/** 一次脚本上传要带的 DO 迁移元数据（形状同 WorkerUpload.migrations）。 */
export interface DoMigrationPlan {
  oldTag?: string;
  newTag: string;
  steps: Array<Record<string, unknown>>;
  /** 本次要应用的 tag（按声明序，与 steps 一一对应）——上传成功后逐条记账。 */
  tags: string[];
}

/**
 * DO 迁移计划（#255）：判定依据是**模块记账表里已记的 tag**（事实），
 * 不再用「脚本是否存在」当「DO 类是否已建」的代理（两者不等价：占位 stub / 手工
 * wrangler 部署都会让脚本已存在而类未建）。
 *
 * - `declared` 按包配置顺序（wrangler migrations 数组顺序即应用顺序）；
 * - 全部 tag 已记账 → `undefined`（幂等重传不带 migrations；重复 tag 会被 CF 拒：
 *   `Migration tag precondition failed; current tag is <t>`，实测版本见 #255 探针记录）；
 * - `oldTag` = 首个未记账 tag 之前最后一个已记账 tag（无则省略 = 无前序迁移的首应用）；
 * - 未记账 tag 逐个生成 `new_sqlite_classes` 步，`newTag` = 最后一个声明 tag。
 *
 * 记账不连续（后面的 tag 已记、前面的未记）说明库里有夹缝——宁停不住，报出具体 tag。
 */
export function planDoMigrations(input: {
  declared: DoMigrationDeclaration[];
  appliedNames: string[];
}): DoMigrationPlan | undefined {
  const applied = new Set(input.appliedNames);
  let oldTag: string | undefined;
  let newTag: string | undefined;
  const steps: Array<Record<string, unknown>> = [];
  const tags: string[] = [];
  for (const decl of input.declared) {
    if (applied.has(doMigrationLedgerName(decl.tag))) {
      if (steps.length > 0) {
        throw new Error(
          `DO 迁移记账不连续：tag "${decl.tag}" 已记账，但更早的 tag 尚未记账（前一个待应用 tag "${newTag}"）——` +
            '先核对该模块记账表，不要带着夹缝部署',
        );
      }
      oldTag = decl.tag;
      continue;
    }
    steps.push({ new_sqlite_classes: [...decl.new_sqlite_classes] });
    tags.push(decl.tag);
    newTag = decl.tag;
  }
  if (!newTag || steps.length === 0) return undefined;
  return { ...(oldTag !== undefined ? { oldTag } : {}), newTag, steps, tags };
}

/**
 * shared 护栏③（决策 #55）的硬校验：**单一实现住 @unself/contracts**
 * （`shared-guards.ts`），发布期 `unself module validate` 与装配期这里共用一份，防两处漂移。
 *
 * 装配时执行，违者停住：表名必须 `<模块id>_` 前缀 + 外键不得指向本模块申报清单之外的表。
 * `checkSharedGuards` 返回人话消息（既有接口）；结构化问题用 `sharedGuardProblems`。
 */
export { checkSharedGuards, foreignKeyTargets, tablePrefixFor } from '@unself/contracts';

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

/** 迁移模块目录：migrations/<模块id>/（包布局 §2）。
 * #310：shared 落点优先用 `migrations/<模块id>-shared/`（带前缀的物理表集）；不存在时回落
 * `<模块id>/`（单形态模块，其迁移本身即须满足护栏③）。dedicated 恒用 `<模块id>/`。 */
export function migrationDirFor(moduleDir: string, moduleId: string, level: StorageLevel = 'dedicated'): string {
  const base = join(moduleDir, 'migrations', moduleId);
  if (level !== 'shared') return base;
  const sharedDir = join(moduleDir, 'migrations', `${moduleId}-shared`);
  return existsSync(sharedDir) ? sharedDir : base;
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
