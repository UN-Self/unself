// SPDX-License-Identifier: AGPL-3.0-only
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { defaultModuleEntries } from './official-modules';

/**
 * 实例目录布局（决策 #53）：
 * <chosenDir>/unself/
 *   ├── unself.config.jsonc   唯一配置文件（存在即保留用户手改，不覆盖）
 *   ├── unself.lock    骨架锁（本 issue 只落形状，无秘密）
 *   └── generated/            生成物输出目录
 */

export const INSTANCE_DIR_NAME = 'unself';

export interface InstanceLayout {
  /** 实例目录：join(chosenDir, 'unself') */
  instanceDir: string;
  /** 配置文件：instanceDir/unself.config.jsonc */
  configPath: string;
  /** 实例锁：instanceDir/unself.lock */
  lockPath: string;
  /** 生成物目录：instanceDir/generated */
  generatedDir: string;
}

/** 由用户选定的目录推出实例目录内固定布局（纯路径计算，不做 fs）。 */
export function instanceLayout(chosenDir: string): InstanceLayout {
  const instanceDir = join(chosenDir, INSTANCE_DIR_NAME);
  return {
    instanceDir,
    configPath: join(instanceDir, 'unself.config.jsonc'),
    lockPath: join(instanceDir, 'unself.lock'),
    generatedDir: join(instanceDir, 'generated'),
  };
}

const CONFIG_TEMPLATE = `// SPDX-License-Identifier: AGPL-3.0-only
//
// Unself 实例装配配置（唯一配置文件）：
// 装配器（CLI init / Web 向导）与引擎幂等脚本读同一份。
// OIDC 凭证不进本文件——部署后在 setup 向导填写并存 core 库。
{
  // 实例对外域名；留空/省略 → 用 <worker>.workers.dev 临时域（#15 验收路径）
  "domain": "",
  // 资源命名空间（#272）：CF 资源名前缀（<namespace>-core / <namespace>-core-api / <namespace>-storage）。
  // 同一 CF 账户多实例靠它隔离；改动会让已部署资源变成孤儿（需显式 --allow-adopt 接管）。
  "namespace": "__NAMESPACE__",
  // 选中启用的模块（官方模块与第三方一样写 npm 串；决策 #77：没有 official 特权来源）
  // 官方模块由安装器 dependencies 精确预装 → 解析时本地命中，部署零网络；未列出的已存在模块注册表翻转 not_deployed
  "modules": __MODULES__,
  // 对象存储：r2（脚本建桶）或 s3（外部 S3/MinIO 参数）
  "storage": { "provider": "r2" }
}
`;

const LOCK_SKELETON_MODULES: Record<string, never> = {};

/**
 * 空 lock 骨架（形状必须过引擎 `LockFileSchema`：#269 实测旧骨架 `{instance:{},modules:[]}`
 * 缺 generatedAt 且 modules 不是 record，干净实例首跑 `unself deploy` 会直接「结构非法」）。
 */
function lockSkeleton(): string {
  return JSON.stringify(
    {
      lockVersion: 1,
      generatedAt: new Date().toISOString(),
      modules: LOCK_SKELETON_MODULES,
    },
    null,
    2,
  ) + '\n';
}

export interface CreateInstanceDirOptions {
  /** 写入配置的启用模块条目（`{id, source}`）；缺省 = 官方模块的 npm 串（决策 #77）。 */
  modules?: Array<{ id: string; source: string }>;
  /**
   * 资源命名空间（#272）：写入 unself.config.jsonc 的 `namespace` 字段。
   * 缺省 = 从实例目录名派生（`mysite` → `mysite`；非法字符转 `-`）。
   */
  namespace?: string;
}

/** 命名空间形态（与引擎 naming.NAMESPACE_RE 同源；一致性由测试锁住）。 */
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** 由实例名派生合法命名空间（小写、非法字符转 `-`、去首尾/重复 `-`、限长 40；空则回退 `unself`）。 */
export function deriveNamespace(instanceName: string): string {
  const cleaned = instanceName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const candidate = cleaned.length > 0 ? cleaned : 'unself';
  return NAMESPACE_RE.test(candidate) ? candidate : 'unself';
}

export interface CreateInstanceDirResult {
  layout: InstanceLayout;
  /** 本次运行是否新写入了配置文件（false = 已存在，保留用户手改） */
  configCreated: boolean;
  /** 本次运行是否新写入了锁骨架（false = 已存在） */
  lockCreated: boolean;
  /** 写入配置的命名空间（#272；config 已存在时为 undefined——保留用户手改）。 */
  namespace?: string;
}

/**
 * 创建实例目录结构（幂等）：
 * - instanceDir 与 generated/ 递归创建，已存在不动；
 * - configPath 仅在不存在时写入带注释 JSONC 模板（存在即保留用户手改）；
 * - lockPath 仅在不存在时写入骨架 JSON（本 issue 只落形状，无秘密）。
 */
export function createInstanceDir(
  chosenDir: string,
  opts: CreateInstanceDirOptions = {},
): CreateInstanceDirResult {
  const layout = instanceLayout(chosenDir);
  mkdirSync(layout.generatedDir, { recursive: true });

  // 命名空间（#272）：显式给或从实例目录名派生（实例名 = basename(chosenDir)，与 loadInstance 一致）。
  const namespace = opts.namespace ?? deriveNamespace(basename(resolve(chosenDir)));

  const configCreated = !existsSync(layout.configPath);
  if (configCreated) {
    const modules = opts.modules ?? defaultModuleEntries();
    const body = CONFIG_TEMPLATE
      .replace('"__NAMESPACE__"', `"${namespace}"`)
      .replace(
        '"modules": __MODULES__',
        `"modules": [${modules.map((m) => `{ "id": "${m.id}", "source": "${m.source}" }`).join(', ')}]`,
      );
    writeFileSync(layout.configPath, body);
  }

  const lockCreated = !existsSync(layout.lockPath);
  if (lockCreated) {
    writeFileSync(layout.lockPath, lockSkeleton());
  }

  return {
    layout,
    configCreated,
    lockCreated,
    ...(configCreated ? { namespace } : {}),
  };
}

export interface LoadedInstance {
  /** 实例名 = 实例目录父目录名（basename(dirname(instanceDir))) */
  name: string;
  /** 实例目录绝对路径 */
  path: string;
}

/**
 * 校验并读取实例目录：instanceDir 与 configPath 都存在才有效，
 * 否则抛出含具体路径的人话 Error。不做内容解析。
 */
export function loadInstance(path: string): LoadedInstance {
  const layout = instanceLayout(path);
  if (!existsSync(layout.instanceDir)) {
    throw new Error(`实例目录不存在：${layout.instanceDir}（请先运行 init 创建实例）`);
  }
  if (!existsSync(layout.configPath)) {
    throw new Error(`实例配置缺失：${layout.configPath}（实例目录存在但缺 unself.config.jsonc）`);
  }
  return {
    name: basename(dirname(layout.instanceDir)),
    path: resolve(layout.instanceDir),
  };
}
