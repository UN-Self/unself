// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块生命周期契约（PRODUCT_SPEC §5.4）：
 * manifest 之外每模块必须实现的生命周期接口与导出/清除数据形状。
 * 类型仅供模块与 Core 共同引用；M0 由 hello 模块提供第一份实现。
 */

/**
 * 模块生命周期接口。
 * 模块在自身入口导出一个实现（如 `export const lifecycle: ModuleLifecycle`），
 * Core 卸载/备份/离职流程按接口调用，不进入模块内部实现。
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
