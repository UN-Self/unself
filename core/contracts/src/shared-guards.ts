// SPDX-License-Identifier: AGPL-3.0-only
/**
 * shared 三护栏之③（决策 #55，docs/modules.md §4/§6）：表名 `<模块id>_` 前缀 + 禁止跨模块外键。
 *
 * **单一实现**：#248 装配期的硬校验（app/installer/src/engine/migrate.ts）与发布期
 * `unself module validate` 共用这一份——两处各写一套必然漂移，而漂移只在装到一半时才暴露。
 *
 * schema 层只兜护栏②（accepts 含 shared 必申报 tables）；护栏③（前缀/外键）是迁移文本级检查，
 * 归这里与 validate。
 */
import { parseSqlStructure } from './sql-tables';

// 单一 SQL 标识符解析在 sql-tables.ts；这里只保留 public 可见面（安装器经此再导出）。
export { foreignKeyTargets } from './sql-tables';

/** 参与护栏校验的迁移文件（文件名 + SQL 原文）。 */
export interface SharedGuardMigration {
  name: string;
  sql: string;
}

/** 护栏③问题分类：prefix=表名缺模块前缀；undeclared=建了未申报的表；cross-module-fk=外键指向清单外；sql-parse=不支持/矟形的语法。 */
export type SharedGuardProblemKind = 'prefix' | 'undeclared' | 'cross-module-fk' | 'sql-parse';

/** 一条护栏问题：带分类、表名、迁移文件与人话消息（消息文案保持与 #248 装配期一致）。 */
export interface SharedGuardProblem {
  kind: SharedGuardProblemKind;
  /** 出问题的表名（prefix/undeclared = 迁移建的表；cross-module-fk = 被引用的表）。 */
  table: string;
  /** 迁移文件名（护栏定位到文件，装配期与发布期报错同款粒度）。 */
  file: string;
  message: string;
}

/** shared 护栏③：表名必须以 `<模块id>_` 开头（模块 id 内的 - 转 _）。 */
export function tablePrefixFor(moduleId: string): string {
  return `${moduleId.replaceAll('-', '_')}_`;
}

/**
 * 护栏③硬校验：返回全部问题（结构化，调用方决定拦/报）。
 * - 迁移建的每张表必须以 `<模块id>_` 前缀命名；
 * - 建的表必须在 tables 申报清单内（护栏②兜底）；
 * - FOREIGN KEY 引用的表只能是本模块申报清单内的表（禁止跨模块外键）。
 */
export function sharedGuardProblems(input: {
  moduleId: string;
  tables: string[];
  migrations: SharedGuardMigration[];
}): SharedGuardProblem[] {
  const problems: SharedGuardProblem[] = [];
  const prefix = tablePrefixFor(input.moduleId);
  const declared = new Set(input.tables);
  const push = (kind: SharedGuardProblemKind, table: string, file: string, message: string): void => {
    problems.push({ kind, table, file, message });
  };

  for (const file of input.migrations) {
    // 先做词法/语法解析（保持 token 类型与边界）：护栏③的命名/外键判定都基于解析结果，
    // 不支持的语法位置（如 `CREATE TABLE 'x'`）必须显式拒绝，不能静默漏过。
    const parsed = parseSqlStructure(file.sql);
    for (const problem of parsed.problems) {
      push('sql-parse', '', file.name, `${input.moduleId} / ${file.name}：${problem}`);
    }
    // ① 前缀硬校验：CREATE TABLE 的表名必须带模块前缀
    for (const name of parsed.tables) {
      if (!name.startsWith(prefix)) {
        push(
          'prefix',
          name,
          file.name,
          `${input.moduleId} / ${file.name}：表 ${name} 不带模块前缀 ${prefix}（shared 护栏③，docs/modules.md §6 规则3）`,
        );
      }
      if (!declared.has(name)) {
        push(
          'undeclared',
          name,
          file.name,
          `${input.moduleId} / ${file.name}：表 ${name} 不在 tables 申报清单内（护栏②「共享库不接收未经申报的表」）`,
        );
      }
    }
    // ② 跨模块外键硬校验：FOREIGN KEY … REFERENCES <表> 只允许指向本模块申报的表
    for (const ref of parsed.references) {
      if (!declared.has(ref)) {
        push(
          'cross-module-fk',
          ref,
          file.name,
          `${input.moduleId} / ${file.name}：外键引用了清单之外的表 ${ref}（禁止跨模块外键，护栏③）`,
        );
      }
    }
  }
  return problems;
}

/**
 * 人话消息形态（#248 装配期既有接口）：`sharedGuardProblems().map(message)`。
 * 保留它是为了装配期错误文案与既有测试零改动。
 */
export function checkSharedGuards(input: {
  moduleId: string;
  tables: string[];
  migrations: SharedGuardMigration[];
}): string[] {
  return sharedGuardProblems(input).map((p) => p.message);
}
