// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 运行时装配（issue #349 模式一，决策 #109）：在壳里装后增补单个 CF 模块。
 *
 * 边界（决策 #109 定案，写死在代码里而不是靠约定）：
 * - **首装仍归 installer**：这里只做「实例已经跑起来之后，再补一个模块」，不承担 core
 *   自身的部署（D1/R2/KV/路由/密钥都在装配期定好，运行时不再碰）。
 * - **CF token 会话内用后即焚**（#165）：只活在本次请求的作用域里，不落库、不进日志、
 *   不进审计 detail。用完显式清引用（`wipe()`），路由层随后还会把请求体里的副本抹掉。
 * - **包的信任边界与 installer 同源**（#58）：远端一律已打包，解包即用，不执行包内任何
 *   脚本；manifest 真相是包内 `manifest.json`（#78），未知能力在 schema 层直接拒（#56）。
 *
 * 已知限制（诚实标注，不做"看起来能跑"的假象）：
 * - 单文件 ESM 上传（`worker.js`），不带 bindings/migrations/assets。带 DO/资产/迁移的模块
 *   （chat 等）仍走 installer 装配期路径；本端点是"增补简单模块"的过渡形态，完全形态随
 *   D8（core Node 运行体）/ D4（向导扩展）收敛。
 * - workers.dev 子域启用、路由绑定、secrets 下发不在本端点职责内（需要 zone 级能力，
 *   且与 #165 凭证纪律冲突：那些动作应留在部署期）。
 */

import { ModuleManifestSchema, type ModuleManifest } from '@unself/contracts';

import { fetchNpmPackage, readTextFile } from './npm-tarball';

/** CF API 版本面（与 installer REST 客户端同源：v4）。 */
const CF_API = 'https://api.cloudflare.com/client/v4';

/** 运行时装配的入参（cfToken 只在本作用域，调用方用完即抹）。 */
export interface RuntimeInstallInput {
  /** npm 规格：`name` / `name@1.2.3` / `@scope/name@1.2.3`。 */
  npmSpec: string;
  /** CF API token（会话内凭证，#165）。 */
  cfToken: string;
  /** CF account id（脚本上传的账号维度）。 */
  accountId: string;
  /** 脚本名覆盖（默认 = manifest.id；实例内模块 id 与 worker 名一致，便于人工排查）。 */
  scriptName?: string;
}

/** 装配产物（路由层据此写 registry + 审计）。 */
export interface RuntimeInstallResult {
  manifest: ModuleManifest;
  version: string;
  scriptName: string;
  /** 包内文件清单（诊断用；不落库）。 */
  files: string[];
}

/** 人话装配错误（路由层转 400/502，不把 CF 原始响应整段回给前端）。 */
export class RuntimeInstallError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
    this.name = 'RuntimeInstallError';
  }
}

/**
 * 装配一个 npm 模块到 CF：拉 tarball → 校 manifest（含权限词表）→ 上传 worker。
 * 不写 registry——注册与落点三列由路由层用同一条 `upsertModule` 通道落（单一写入口）。
 */
export async function installNpmModule(
  input: RuntimeInstallInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeInstallResult> {
  const pkg = await fetchNpmPackage(input.npmSpec, fetchImpl);

  // manifest.json 是包的真相（#78：安装侧只看它，不看 package.json）
  const manifestText = readTextFile(pkg, 'package/manifest.json');
  if (!manifestText) {
    throw new RuntimeInstallError('包内缺少 manifest.json（远端来源必须是已打包形态，#58）', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new RuntimeInstallError('包内 manifest.json 不是合法 JSON', 400);
  }
  const schema = ModuleManifestSchema.safeParse(parsed);
  if (!schema.success) {
    // 未知能力/形状错在 schema 层就拒（#56：静默丢会致授牌错误）——点名到具体字段
    const detail = schema.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；');
    throw new RuntimeInstallError(`manifest 校验失败：${detail}`, 400);
  }
  // 未知能力不再后置过滤：ModulePermissionSchema = z.enum(MODULE_PERMISSIONS) 在 schema 层
  // 直接拒（词表单点 @unself/contracts/manifest.ts；上方 issues 映射已点名到 permissions.N），
  // 走不到这里——保留本地过滤就是第二份词表规则（消融实验 B 删除）。
  const manifest = schema.data;

  const worker = readTextFile(pkg, 'package/worker.js');
  if (!worker) {
    throw new RuntimeInstallError('包内缺少 worker.js（远端来源必须是已打包形态，#58）', 400);
  }

  const scriptName = input.scriptName ?? manifest.id;
  await uploadWorkerScript(fetchImpl, {
    cfToken: input.cfToken,
    accountId: input.accountId,
    scriptName,
    workerSource: worker,
  });

  return {
    manifest,
    version: pkg.ref.version,
    scriptName,
    files: [...pkg.files.keys()],
  };
}

/**
 * 上传 worker（ESM 单文件）。
 * multipart 形状与 installer REST 客户端同源（#65：metadata = JSON 字符串，文件以文件名为字段名）。
 */
async function uploadWorkerScript(
  fetchImpl: typeof fetch,
  opts: { cfToken: string; accountId: string; scriptName: string; workerSource: string },
): Promise<void> {
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2024-11-01',
    // 不带 bindings（见文件头「已知限制」）：简单模块的 CORE_API/JWKS 由装配期路径供给
  };
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  form.set('worker.js', new Blob([opts.workerSource], { type: 'application/javascript+module' }), 'worker.js');

  const res = await fetchImpl(
    `${CF_API}/accounts/${encodeURIComponent(opts.accountId)}/workers/scripts/${encodeURIComponent(opts.scriptName)}`,
    {
      method: 'PUT',
      // token 只在这一跳的 header 里；不写日志、不进异常文案
      headers: { authorization: `Bearer ${opts.cfToken}` },
      body: form,
    },
  );
  if (!res.ok) {
    // 只回状态码与 CF 的 errors[].message（脱敏：不带 token，也不带整个响应体）
    const body = await res.json().catch(() => null) as { errors?: Array<{ message?: string }> } | null;
    const reason = body?.errors?.map((e) => e.message).filter(Boolean).join('；') || '无错误详情';
    throw new RuntimeInstallError(`CF 脚本上传失败（HTTP ${res.status}）：${reason}`, 502);
  }
}

/** 抹掉凭证引用（#165：用完即焚；调用方在 finally 里执行）。 */
export function wipeCredential(holder: { cfToken: string }): void {
  holder.cfToken = '';
}
