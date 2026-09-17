// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * 模块清单（manifest.json）契约 v1：字段冻结（决策 #56/#57，2026-09-17 定稿）。
 * 权威字段表：docs/modules.md §3；本文件是词表与契约版本的权威去处。
 *
 * 冻结字段：id / version / route / entry / runtimes / storage / config / tables / compat / icon / description / permissions
 * 已删除（#56）：capabilities（「模块提供什么功能」不属 core 契约，放错层）与 requires（恒定值、无消费者）。
 */

/**
 * 契约版本（决策 #57）：独立于产品版本，只在破坏性变更时 bump；
 * 增量变更（新字段有默认值、新能力入词表、新端点）不拦人。
 * manifest.compat 省略 = 接受任意版本。
 */
export const CONTRACT_VERSION = '1.0';

/**
 * permissions 能力词表 v1（决策 #56）：门禁——模块向平台请求的权限。
 * 词表归 core 定义并随契约版本走，模块不得自定义；
 * 未知能力在安装（validate/注册）时直接拒绝，不静默忽略（#64：静默丢会致授牌错误）。
 * 未声明即调用对应 Core API → 403（core-api /api/module-api/* 按词放行）。
 */
export const MODULE_PERMISSIONS = ['storage', 'acl', 'notify', 'ai', 'realtime', 'mail'] as const;

/** 能力词表成员类型。 */
export type ModulePermission = (typeof MODULE_PERMISSIONS)[number];

/** 词表 schema：词表外的值直接 parse 失败（未知能力拒绝）。 */
export const ModulePermissionSchema = z.enum(MODULE_PERMISSIONS);

/** 运行时类型：worker（workerd）、docker 容器、external（自托管外部服务）。 */
export const ModuleRuntimeSchema = z.enum(['worker', 'docker', 'external']);

/** 数据落点四级（决策 #55）：core（经 Core API 代理）/ shared / dedicated / external。 */
export const StorageLevelSchema = z.enum(['core', 'shared', 'dedicated', 'external']);

/** storage 声明：accepts 非空子集 + 可选偏好；部署者从 accepts 里选，选外即拒绝安装。 */
export const ModuleStorageSchema = z.object({
  /** 本模块支持的数据落点（至少一项）。 */
  accepts: z.array(StorageLevelSchema).min(1),
  /** 安装器默认勾选的偏好；必须是 accepts 的成员。 */
  preferred: StorageLevelSchema.optional(),
});

/** 配置页字段声明（决策 #53/#66）：安装器渲染表单，不执行模块提供的页面。 */
export const ModuleConfigFieldSchema = z.object({
  /** 环境变量 / secret 名。 */
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  /** 中文标签（部署者看到的就是这个）。 */
  label: z.string().min(1),
  /** 字段类型：secret 走 wrangler/docker secret，不落配置文件（docs/modules.md §5）。 */
  type: z.enum(['string', 'secret', 'number', 'boolean', 'enum', 'url', 'json', 'oauth']),
  /** 是否必填。 */
  required: z.boolean().optional(),
  /** 缺省值（json 类型给字符串形态）。 */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** enum 类型的候选。 */
  options: z.array(z.string()).min(1).optional(),
  /** 连接测试标识（pg / s3 / http…），安装器据此提供「测试连接」按钮。 */
  test: z.string().optional(),
});

/** config schema：字段数组（docs/modules.md §5）。 */
export const ModuleConfigSchema = z.array(ModuleConfigFieldSchema);

/** compat 区间（决策 #57）：x.y 形态，min ≤ max；省略 = 接受任意契约版本。 */
export const ContractCompatSchema = z
  .object({
    min: z.string().regex(/^\d+\.\d+$/),
    max: z.string().regex(/^\d+\.\d+$/),
  })
  .refine((v) => compareContractVersion(v.min, v.max) <= 0, {
    message: 'compat.min 必须 ≤ compat.max',
  });

/** 比较两个 x.y 契约版本：负 = a<b，0 = 相等，正 = a>b。 */
export function compareContractVersion(a: string, b: string): number {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  return (aMajor ?? 0) - (bMajor ?? 0) || (aMinor ?? 0) - (bMinor ?? 0);
}

/** 表名声明清单：shared 模式必需（卸载/备份按清单执行）；dedicated 建议申报。 */
const TableNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * 模块清单契约 v1（docs/modules.md §3 字段冻结表）。
 * 硬护栏（schema 层直接拒绝）：storage.accepts 含 shared 时必须申报 tables；
 * preferred 必须是 accepts 成员。其余语义检查（六类）在 validate 模块。
 */
export const ModuleManifestSchema = z
  .object({
    /** 模块 id：作者建议的实例内名字（决策 #59，全局身份=包名/来源），小写字母开头。 */
    id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    /** semver 版本号（x.y.z）；实例侧确切版本另记在 unself.lock。 */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** 本模块支持跑在哪（决定可选的部署 mode，决策 #54）；至少一项。 */
    runtimes: z.array(ModuleRuntimeSchema).min(1),
    /** 挂载路由建议值，必须以 /m/ 开头；同域路径制下由装配器生成 /m/<id>/*。 */
    route: z.string().startsWith('/m/'),
    /** 模块入口 URL：external 为模块自身地址；其他运行时由装配器覆写为实例内地址。 */
    entry: z.url(),
    /** 权限门禁声明（词表见 MODULE_PERMISSIONS）；省略 = 不调用任何需授权的 Core API。 */
    permissions: z.array(ModulePermissionSchema).optional(),
    /** 数据落点声明；省略等价于只支持 core（#55）。 */
    storage: ModuleStorageSchema.optional(),
    /** 本模块的表名清单：accepts 含 shared 时必需（硬护栏）。 */
    tables: z.array(TableNameSchema).optional(),
    /** 配置页字段声明（#53/#66）。 */
    config: ModuleConfigSchema.optional(),
    /** 契约版本区间（#57）；省略 = 接受任意版本。 */
    compat: ContractCompatSchema.optional(),
    /** 壳展示用描述（可选）。 */
    description: z.string().optional(),
    /** Lucide 图标名（可选）；缺省/未知回退模块名首字，拒绝 emoji。 */
    icon: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  })
  .superRefine((manifest, ctx) => {
    const accepts = manifest.storage?.accepts;
    if (accepts?.includes('shared') && (!manifest.tables || manifest.tables.length === 0)) {
      // docs/modules.md §4 三护栏之一：shared 必须申报表名清单（卸载/备份按清单执行）
      ctx.addIssue({
        code: 'custom',
        path: ['tables'],
        message: 'storage.accepts 含 shared 时必须申报 tables（表名清单，docs/modules.md §4 护栏②）',
      });
    }
    if (manifest.storage?.preferred && accepts && !accepts.includes(manifest.storage.preferred)) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'preferred'],
        message: `storage.preferred=${manifest.storage.preferred} 不在 accepts 内`,
      });
    }
  });

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
