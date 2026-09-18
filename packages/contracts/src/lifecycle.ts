// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块生命周期契约（PRODUCT_SPEC §5.4）：manifest 之外的生命周期接口与导出/清除数据形状。
 *
 * ## #270 卸载定案：平台驱动清理，**无模块内卸载钩子**
 *
 * 卸载（W4 验收④「卸载走生命周期端点导出与清理，验完库里无残留表」）由**平台**执行，
 * 依据注册表快照里的 `storage.declaration` + `manifest.tables` 清单：
 *   - shared  → 共享 modules 库 `DROP TABLE` 清单内每张表；
 *   - dedicated → 该模块专属 D1 做同样清理；
 *   - core / external → 平台不碰数据（core 的表归 core，external 归模块自己）；
 *   随后清理该模块的迁移记账表 `unself_migrations_<id>`（#248/#255 同一套记账，见
 *   `platformUninstallPlan()` 的返回）。
 * 引擎只持有「上传 Worker」通道，无法调用模块入口对象；且存量模块（如 chat）并未实现
 * `/life/purge`——把钩子设为卸载必选会让卸载对现有模块直接不可用。故卸载**不做**钩子。
 *
 * 导出（备份剧本）仍是模块面：M0/M1 阶段的真值是 HTTP 端点 `GET /life/export`
 * （模块路由下，路径逻辑同 Hello 的 /life/*），卸载不依赖它。
 * 下方的 ModuleLifecycle 对象接口保持「预留」：M6 备份编排需要时才接入，
 * 模块在自身入口导出该对象；此前它只是形状约定，不要按它实现，也不是卸载路径。
 */

/**
 * 模块生命周期接口（**预留，非卸载路径**）。
 * 模块在自身入口导出一个实现（如 `export const lifecycle: ModuleLifecycle`），
 * 备份/离职流程按接口调用，不进入模块内部实现；卸载见文件头注的 #270 定案。
 * ⚠ 注意：截至 M2，此对象接口尚未在运行时接入——当前真值见文件头注（HTTP 端点）。
 */
export interface ModuleLifecycle {
  /** 按表前缀全量导出：JSON + 文件引用（§5.4 管理员「导出并删除」与备份剧本用）。 */
  export(): Promise<ExportBundle>;
  /** 彻底清除本模块全部表与对象前缀（§5.4 卸载「直接删除」剧本用）。 */
  purge(): Promise<void>;
}

/**
 * 模块全量导出包（§5.4）：JSON 表数据 + 文件引用，不含二进制内容。
 * 备份 = core 导一次 + modules 按表导出启用模块 + R2 整体（§5.4）。
 */
export interface ExportBundle {
  /** 契约版本，当前恒为 1。向上兼容用版本号演进。 */
  version: 1;
  /** 导出模块 id（表前缀）。 */
  moduleId: string;
  /** 导出时间（ISO 8601 UTC）。 */
  exportedAt: string;
  /** 每张表一个条目，键为去前缀表名（如 `hello_counter`）。 */
  tables: Record<string, ExportTable>;
  /** 存储层对象引用（R2/S3 键，不含二进制内容）。 */
  files: ExportFileRef[];
}

/** 导出包内单张表的条目。 */
export interface ExportTable {
  /** 行 schema 版本（默认 1），随模块迁移演进。 */
  schemaVersion: number;
  /** 全量行数据；行形状归模块自己的 schema 管，契约不做二次校验。 */
  rows: unknown[];
}

/** 导出包内的存储对象引用。 */
export interface ExportFileRef {
  /** 存储层完整对象键（含模块前缀，如 `hello/xx.png`）。 */
  key: string;
  /** 字节大小；未知时省略。 */
  size?: number;
  /** 可选 MIME 类型。 */
  contentType?: string;
}

/** CreateModuleSDKOptions 风格的导出参数（保留供导出工具复用）。 */
export interface ExportOptions {
  /** 导出模块 id。 */
  moduleId: string;
}

// ---------------------------------------------------------------------------
// 卸载策略（#270 定案；引擎/安装器消费）
// ---------------------------------------------------------------------------

/**
 * 卸载策略（#270 定案，2026-09-18）：
 * - `platform-tables-cleanup`：平台按注册表快照的 storage.declaration + manifest.tables 清理，
 *   无模块内钩子（**当前唯一取值**，见文件头注的定案理由）；
 * - `module-hook`：Core 调模块入口的 ModuleLifecycle.purge()（预留，未实现）。
 */
export type ModuleUninstallStrategy = 'platform-tables-cleanup' | 'module-hook';

/** 当前生效的卸载策略（契约层常量，避免引擎与文档各写一份口径）。 */
export const MODULE_UNINSTALL_STRATEGY: ModuleUninstallStrategy = 'platform-tables-cleanup';

/** 平台卸载计划：由 manifest 快照算出「该删哪些表」，是卸载的**唯一**删表依据。 */
export interface PlatformUninstallPlan {
  moduleId: string;
  /** 生效数据落点（declaration ?? preferred ?? core）；决定清理哪个库。 */
  level: 'core' | 'shared' | 'dedicated' | 'external';
  /**
   * 要 `DROP` 的表名——**只来自 manifest.tables 清单，绝不推断/前缀扫描**（「不许误删」硬规则）。
   * core / external 落点为空（平台不碰数据）。
   */
  tables: string[];
}

/** 生效数据落点：用户选定（declaration）优先，其次作者偏好（preferred），最后 core。 */
export function effectiveStorageLevel(manifest: {
  storage?: { declaration?: string; preferred?: string };
}): PlatformUninstallPlan['level'] {
  const declared = manifest.storage?.declaration;
  if (declared === 'shared' || declared === 'dedicated' || declared === 'external' || declared === 'core') {
    return declared;
  }
  const preferred = manifest.storage?.preferred;
  if (preferred === 'shared' || preferred === 'dedicated' || preferred === 'external') {
    return preferred;
  }
  return 'core';
}

/**
 * 平台卸载计划（#270）：落点 + 待删表清单。
 * shared / dedicated 才返回非空 tables（取自 manifest.tables）；core / external 无表可删。
 * 未申报 tables 的自建表落点 → 空清单（宁可不删，也绝不按前缀猜表名误删）。
 */
export function platformUninstallPlan(manifest: {
  id?: string;
  storage?: { declaration?: string; preferred?: string };
  tables?: string[];
}): PlatformUninstallPlan {
  const level = effectiveStorageLevel(manifest);
  const selfBuilt = level === 'shared' || level === 'dedicated';
  return {
    moduleId: manifest.id ?? '',
    level,
    tables: selfBuilt ? [...(manifest.tables ?? [])] : [],
  };
}
