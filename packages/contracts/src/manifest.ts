// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * 模块清单（module.json）契约：模块元数据在构建/加载时的校验与交换格式。
 */
export const ModuleManifestSchema = z.object({
  /** 模块唯一 id：小写字母开头，仅小写字母、数字、连字符。 */
  id: z.string().regex(/^[a-z][a-z0-9-]+$/),
  /** 模块在 Core 下的挂载路由，必须以 /m/ 开头。 */
  route: z.string().startsWith('/m/'),
  /** 模块入口（bundle / worker 入口）URL。 */
  entry: z.url(),
  /** 运行时类型：worker（workerd）、docker 容器、external（自托管外部服务）。 */
  runtime: z.enum(['worker', 'docker', 'external']),
  /** 模块声明的平台能力需求，至少包含一项（当前必为 identity）。仅支持 block 式 YAML（flow 式 `[a,b]` 由部署器拒绝，#64）。 */
  requires: z.array(z.enum(['identity'])).min(1),
  /** 模块请求的能力列表（对应 Core 能力授牌粒度）。仅支持 block 式 YAML（同上）。 */
  capabilities: z.array(z.string()),
  /** semver 版本号（x.y.z）。 */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** 模块描述（可选）。 */
  description: z.string().optional(),
  /** 图标名（可选）：Lucide 图标名 [a-z0-9-]+，壳白名单映射渲染；缺省/未知回退模块名首字（§5.1，拒绝 emoji）。 */
  icon: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
