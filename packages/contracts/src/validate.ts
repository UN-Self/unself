// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `unself module validate`：发布/安装前检查（docs/modules.md §7，issue #243）。
 *
 * 六类硬错（任何一类即失败）：
 *  1. id 不合法或与包名不一致
 *  2. storage.accepts 与代码实际用法不符（声明 core 却直连数据库等）
 *  3. tables 清单与迁移文件建的表不一致
 *  4. 缺 LICENSE / NOTICE（GPL 类模块）
 *  5. permissions 里有未知能力（词表见 MODULE_PERMISSIONS）
 *  6. compat 与当前契约版本不匹配
 *
 * 硬规则说明：
 * - schema 层已拦「未知权限」（ModulePermissionSchema 拒绝词表外的值），这里作为
 *   独立检查项再报一次人话错误——validate 的输入允许先 raw-parse 出诊断再给检查清单。
 * - 表名硬护栏 `<模块id>_` 前缀与 shared 护栏在 schema（superRefine）与 checkTables 两处
 *   落地，validate 汇总报告。
 * - 未知字段出 warning 不拦人（决策 #57：增量变更不拦——新字段有默认值即可）。
 */
import {
  compareContractVersion,
  CONTRACT_VERSION,
  ModuleManifestSchema,
  MODULE_PERMISSIONS,
  type ModuleManifest,
  type ModulePermission,
} from './index';
import { manifestYamlToCandidate, parseManifestYamlFields, type ManifestCandidate } from './manifest-yaml';

export { manifestYamlToCandidate, parseManifestYamlFields };
export type { ManifestCandidate };

/** license 证据缺失或非法时的兜底标签。 */
export const LICENSE_REQUIRED = 'LICENSE';

/** 单条诊断：level=error 拦发布，warning 提示不拦人。 */
export interface ValidateDiagnostic {
  level: 'error' | 'warning';
  /** 检查类目（对应 docs/modules.md §7 六类 + extra）。 */
  check:
    | 'id'
    | 'storage'
    | 'tables'
    | 'license'
    | 'permissions'
    | 'compat'
    | 'entry'
    | 'schema'
    | 'extra';
  message: string;
}

/** validate 结果：errors 非空 = 不通过。 */
export interface ValidateResult {
  ok: boolean;
  errors: ValidateDiagnostic[];
  warnings: ValidateDiagnostic[];
}

/** 建表 SQL 的 CREATE TABLE 表名抓取（容忍引号、IF NOT EXISTS、schema 修饰省略）。 */
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;

/** 迁移文件命名：000N_描述.sql（docs/modules.md §6，只增不改）。 */
const MIGRATION_FILE_RE = /^0\d{3}_[A-Za-z0-9_-]+\.sql$/;

/** 从 SQL 文本抓全部建表表名（去重）。 */
export function tableNamesFromSql(sql: string): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(CREATE_TABLE_RE)) {
    names.add(match[1]!);
  }
  return [...names];
}

/** manifest.yaml 文本（模块作者书写格式）→ 契约候选对象（§3 字段名，schema 直接入参）。 */
export function manifestFromYamlText(manifestText: string): ManifestCandidate {
  return manifestYamlToCandidate(parseManifestYamlFields(manifestText));
}

/** validate 输入：模块包在磁盘上的样子（目录 or 解包后的 tarball）。 */
export interface ModulePackageInput {
  /** manifest 声明文本：JSON（包内 manifest.json）或 YAML（仓库内 manifest.yaml）自动判别。 */
  manifestText: string;
  /** 包名（tarball 名 / 目录名 / source 里的 id 部分）；缺省 = 跳过一致性比对。 */
  packageName?: string;
  /** 迁移 SQL 文本按文件名索引（migrations/*.sql）。 */
  migrations?: Record<string, string>;
  /** 包根的 LICENSE 文本；undefined = 缺失。 */
  licenseText?: string;
  /** worker.js 文本；undefined = 缺失。 */
  workerText?: string;
}

/** JSON 解析失败转 Error 返回（不抛出，统一走诊断流）。 */
function safeJsonParse(text: string): unknown | Error {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return new Error(
      `manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** raw manifest 解析结果：schema 诊断 +（成功时的）manifest 对象。 */
function parseManifestWithDiagnostics(manifestText: string): {
  diagnostics: ValidateDiagnostic[];
  manifest?: ModuleManifest;
} {
  const trimmed = manifestText.trim();
  const raw: unknown =
    trimmed.startsWith('{')
      ? safeJsonParse(manifestText)
      : manifestFromYamlText(manifestText);
  if (raw instanceof Error) {
    return {
      diagnostics: [
        {
          level: 'error',
          check: 'schema',
          message: `manifest 解析失败：${raw.message}`,
        },
      ],
    };
  }
  const parsed = ModuleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    // schema 诊断按字段归类到 §7 检查类目（id/permissions/storage/tables/compat），
    // 其余归 schema——六类硬错在报告里保持可追溯，而不是全部笼统报 schema。
    const FIELD_TO_CHECK: Record<string, ValidateDiagnostic['check']> = {
      id: 'id',
      permissions: 'permissions',
      storage: 'storage',
      tables: 'tables',
      compat: 'compat',
    };
    return {
      diagnostics: parsed.error.issues.map((issue) => ({
        level: 'error' as const,
        check:
          (issue.path.length > 0 && FIELD_TO_CHECK[String(issue.path[0])]) || 'schema',
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }
  return { diagnostics: [], manifest: parsed.data };
}

/**
 * 执行第 7 节全部检查。纯函数、零 IO：文件系统/网络由调用方读好喂进来
 * （官方模块走 file: 读取，第三方走 tarball 解包——都归安装器/发布器实现）。
 */
export function validateModulePackage(input: ModulePackageInput): ValidateResult {
  const errors: ValidateDiagnostic[] = [];
  const warnings: ValidateDiagnostic[] = [];

  // manifest 本体：raw-parse + schema（含未知权限 / shared 缺 tables 等硬护栏）
  const { diagnostics: schemaDiagnostics, manifest } = parseManifestWithDiagnostics(input.manifestText);
  errors.push(...schemaDiagnostics);

  if (manifest) {
    // ① id 合法性（schema 已验形状）+ 与包名一致
    if (input.packageName !== undefined && manifest.id !== input.packageName) {
      errors.push({
        level: 'error',
        check: 'id',
        message: `manifest.id=${manifest.id} 与包名 ${input.packageName} 不一致`,
      });
    }
    // ⑤ permissions 词表检查（人话版：词表外的值在 schema 层已被拒，这里兜人话）
    const unknownPermissions = (manifest.permissions ?? []).filter(
      (p): p is ModulePermission & string => !(MODULE_PERMISSIONS as readonly string[]).includes(p),
    );
    if (unknownPermissions.length > 0) {
      errors.push({
        level: 'error',
        check: 'permissions',
        message: `未知权限：${unknownPermissions.join(', ')}（词表：${MODULE_PERMISSIONS.join('/')}）`,
      });
    }

    // ② storage.accepts 与实现用法一致性：core 级走 Core API 代理，SDK 层本身直连数据库
    //    （shared/dedicated 直连 MODULES_DB，external 直连外部库），
    //    因此「包内自带迁移」却未声明 core 之外任一级 = 声明与实现不符。
    const hasMigrations = Object.keys(input.migrations ?? {}).length > 0;
    const accepts = manifest.storage?.accepts ?? (['core'] as const);
    if (hasMigrations && accepts.length === 1 && accepts[0] === 'core') {
      errors.push({
        level: 'error',
        check: 'storage',
        message:
          '包内携带 migrations/ 但 storage.accepts 只有 core——core 级 schema 归 core，模块不得自建表（docs/modules.md §4）',
      });
    }

    // ③ tables 清单 vs 迁移建表：accepts 含 shared/dedicated（模块自建表）时逐一对照
    if (accepts.includes('shared') || accepts.includes('dedicated')) {
      if (Object.keys(input.migrations ?? {}).length === 0) {
        errors.push({
          level: 'error',
          check: 'tables',
          message: 'storage.accepts 含 shared/dedicated（自建表）但包内没有 migrations/',
        });
      }
      const declared = new Set(manifest.tables ?? []);
      const created = new Set<string>();
      for (const sql of Object.values(input.migrations ?? {})) {
        for (const name of tableNamesFromSql(sql)) {
          created.add(name);
        }
      }
      const undeclared = [...created].filter((t) => !declared.has(t));
      const missing = [...declared].filter((t) => !created.has(t));
      if (undeclared.length > 0) {
        errors.push({
          level: 'error',
          check: 'tables',
          message: `迁移建了未申报的表：${undeclared.join(', ')}（「共享库不接收未经申报的表」是硬规则）`,
        });
      }
      if (missing.length > 0) {
        errors.push({
          level: 'error',
          check: 'tables',
          message: `tables 申报了迁移未建的表：${missing.join(', ')}（清单与迁移必须一致）`,
        });
      }
      for (const file of Object.keys(input.migrations ?? {})) {
        if (!MIGRATION_FILE_RE.test(file)) {
          errors.push({
            level: 'error',
            check: 'tables',
            message: `迁移文件名 ${file} 不符合 000N_描述.sql（docs/modules.md §6，只增不改）`,
          });
        }
      }
    }

    // ④ LICENSE 存在（NOTICE 属 GPL 类模块的义务，缺 LICENSE 本身已拦）
    if (input.licenseText === undefined) {
      errors.push({
        level: 'error',
        check: 'license',
        message: `包内缺 ${LICENSE_REQUIRED}（许可证随包走；GPL 类模块必须自带 LICENSE/NOTICE）`,
      });
    }

    // ⑥ compat 与当前契约版本匹配（省略 = 接受任意版本，#57）
    if (manifest.compat) {
      const { min, max } = manifest.compat;
      if (compareContractVersion(min, CONTRACT_VERSION) > 0) {
        errors.push({
          level: 'error',
          check: 'compat',
          message: `compat.min=${min} 高于当前契约版本 ${CONTRACT_VERSION}，无法安装`,
        });
      }
      if (compareContractVersion(max, CONTRACT_VERSION) < 0) {
        errors.push({
          level: 'error',
          check: 'compat',
          message: `compat.max=${max} 低于当前契约版本 ${CONTRACT_VERSION}（如确需硬上，安装侧有 --allow-incompatible，#57）`,
        });
      }
    }
  }

  // worker.js 存在且自包含（§2：单文件自包含，零运行时装包）——存在性在此，自包含性归打包器
  if (manifest?.runtimes?.includes('worker') && input.workerText === undefined) {
    errors.push({
      level: 'error',
      check: 'entry',
      message: 'runtimes 含 worker 但包内没有 worker.js（预构建、自包含）',
    });
  }

  // 增量变更不拦人（#57）：未知字段出 warning
  const rawRecord = input.manifestText.trim().startsWith('{')
    ? safeJsonParse(input.manifestText)
    : manifestFromYamlText(input.manifestText);
  if (!(rawRecord instanceof Error) && typeof rawRecord === 'object' && rawRecord !== null) {
    const known = new Set([
      'id',
      'version',
      'runtimes',
      'route',
      'entry',
      'permissions',
      'storage',
      'tables',
      'config',
      'compat',
      'description',
      'icon',
      'coreOrigin',
    ]);
    const unknown = Object.keys(rawRecord).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      warnings.push({
        level: 'warning',
        check: 'extra',
        message: `未知字段被忽略（增量变更不拦人，#57）：${unknown.join(', ')}`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 诊断 → 单行人话（CLI 输出用）。 */
export function formatDiagnostic(d: ValidateDiagnostic): string {
  return `[${d.level}] ${d.check}: ${d.message}`;
}
