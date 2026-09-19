// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 来源预览（issue #269）：把「将要装什么」在装配前算出来，给向导③ / `unself module add` 展示。
 *
 * 与装配期 `resolveSources` 走**同一批原语**（parseSource / resolveLocalNpmPackage / npmResolve /
 * githubResolve / downloadTo / extractTarball / fileStage / readManifest），只少了 lock 记账与落位：
 * 解析来源 → 取包到暂存目录 → 读 manifest（含未知能力门禁）→ 返回 id/版本/SRI/permissions/落点。
 *
 * 四协议（决策 #58/#77）：npm: / github: / https: / file:。npm: 本地 node_modules 命中（版本匹配）
 * 直接用（零网络，与装配期同款），未命中才走 registry。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ModuleManifest, ModulePermission } from '@unself/contracts';
import {
  type ParsedSource,
  downloadTo,
  extractTarball,
  fileStage,
  githubResolve,
  npmResolve,
  parseSource,
  resolveLocalNpmPackage,
} from './sources';
import { readManifest } from './module-sources';

/** 四级落点（契约 StorageLevelSchema 同源）。 */
export type PreviewStorageLevel = 'core' | 'shared' | 'dedicated' | 'external';

export interface ModulePreview {
  /** 生效的实例内 id（作者建议名；部署者可覆盖 —— 覆盖由调用方决定，本函数只报 manifest.id）。 */
  id: string;
  /** 原样来源串（写进 config 的 source）。 */
  source: string;
  kind: ParsedSource['kind'];
  /** 解析出的确切版本（npm 用 registry 响应；其余取 manifest.version）。 */
  version: string;
  /** 包字节 SRI（sha512-…）；builtin/file: 目录形态无下载字节 → undefined。 */
  integrity?: string;
  permissions: ModulePermission[];
  /** 数据落点声明（省略 = 只支持 core）。 */
  storage: { accepts: PreviewStorageLevel[]; preferred?: PreviewStorageLevel };
  manifest: ModuleManifest;
  /** manifest 原文（快照/哈希用）。 */
  manifestText: string;
  /** 解包后的包根绝对路径（装配器可直接复用；file: / npm 本地命中即本地目录）。 */
  packageDir: string;
  /** 包形态：packed = 预构建包；source = 本地源码目录。 */
  form: 'packed' | 'source';
}

export interface PreviewInput {
  source: string;
  /** 相对路径（file:）与 npm 配置（.npmrc）的解析基准，通常是实例根 rootDir。 */
  cwd: string;
  /** 暂存目录（预览缓存）。缺省 = `<cwd>/.deploy/module-preview/<source 摘要>`。 */
  stageDir?: string;
  /** 测试注入口：替换远端抓取（形状同 module-sources 的 fetchers）。 */
  fetchers?: {
    npm?: typeof npmResolve;
    download?: typeof downloadTo;
    github?: typeof githubResolve;
  };
  log?: (msg: string) => void;
}

/**
 * 解析来源并返回预览信息。任一步失败（非法来源 / 下载失败 / SRI 不符 / manifest 非法 /
 * **未知能力**）直接抛人话 Error —— 调用方据此在用户面拒绝。
 */
export async function previewModuleSource(input: PreviewInput): Promise<ModulePreview> {
  const parsed = parseSource(input.source);
  const log = input.log ?? (() => {});
  const stageDir = input.stageDir ?? join(input.cwd, '.deploy', 'module-preview', createHash('sha256').update(input.source).digest('hex').slice(0, 12));

  // ---- file: 本地目录形态：无下载字节 → integrity 省略（与 resolveOne 同款取法）----
  if (parsed.kind === 'file') {
    const staged = await fileStage({ path: parsed.path!, rootDir: input.cwd, log });
    return await previewFromDir({ input, parsed, packageDir: staged.packageDir });
  }

  // ---- tarball 形态：取包 → SRI → 解包 → manifest（readManifest 含未知能力门禁）----
  let tarPath: string;
  let integrity: string;
  let versionHint: string | undefined;

  if (parsed.kind === 'npm') {
    // 决策 #77 A 方案：本地 node_modules 命中（版本匹配）→ 直接用，不上 registry（零网络）。
    const local = resolveLocalNpmPackage({ pkg: parsed.pkg!, version: parsed.version, rootDir: input.cwd, log });
    if (local) {
      return await previewFromDir({ input, parsed, packageDir: local.dir });
    }
    const meta = await (input.fetchers?.npm ?? npmResolve)({ pkg: parsed.pkg!, version: parsed.version, cwd: input.cwd });
    tarPath = join(stageDir, 'pkg.tgz');
    const dl = await (input.fetchers?.download ?? downloadTo)({ url: meta.tarballUrl, dest: tarPath, log });
    // 实测 SRI 必须等于 registry 的 dist.integrity（与 resolveOne 同款文案）：不等即拒绝
    if (dl.sri !== meta.integrity) {
      throw new Error(
        `下载包 SRI 与 registry 元数据不一致（registry ${meta.integrity}，实测 ${dl.sri}）——拒绝安装`,
      );
    }
    integrity = meta.integrity;
    versionHint = meta.version;
  } else if (parsed.kind === 'github') {
    const asset = await (input.fetchers?.github ?? githubResolve)({ repo: parsed.repo!, tag: parsed.tag, cwd: input.cwd });
    tarPath = join(stageDir, 'pkg.tgz');
    // github release 资产无 SRI 元数据 → 记下载实测 SRI（与 resolveOne 同款语义）
    const dl = await (input.fetchers?.download ?? downloadTo)({
      url: asset.url,
      dest: tarPath,
      headers: { Accept: 'application/octet-stream' },
      log,
    });
    integrity = dl.sri;
  } else if (parsed.kind === 'https') {
    tarPath = join(stageDir, 'pkg.tgz');
    const dl = await (input.fetchers?.download ?? downloadTo)({ url: parsed.url!, dest: tarPath, log });
    integrity = dl.sri;
  } else {
    throw new Error(`不支持的处理路径：${input.source}`);
  }

  const { packageDir } = await extractTarball({ tarPath, dest: stageDir });
  const { manifest, text } = await readManifest(packageDir);
  log(`预览 ${input.source}：v${versionHint ?? manifest.version}，包根 ${packageDir}`);
  return {
    id: manifest.id,
    source: input.source,
    kind: parsed.kind,
    version: versionHint ?? manifest.version,
    integrity,
    permissions: manifest.permissions ?? [],
    storage: { accepts: manifest.storage?.accepts ?? ['core'], ...(manifest.storage?.preferred ? { preferred: manifest.storage.preferred } : {}) },
    manifest,
    manifestText: text,
    packageDir,
    form: 'packed',
  };
}

/** 目录形态（file: / npm 本地命中）共用：readManifest（未知能力门禁在此）→ 预览对象。不调 validateModulePackage（目录形态的校验留在装配期；packed 形态装配期会跑）。 */
async function previewFromDir(input: {
  input: PreviewInput;
  parsed: ParsedSource;
  packageDir: string;
}): Promise<ModulePreview> {
  const { manifest, text } = await readManifest(input.packageDir);
  input.input.log?.(`预览 ${input.input.source}：v${manifest.version}，包根 ${input.packageDir}`);
  return {
    id: manifest.id,
    source: input.input.source,
    kind: input.parsed.kind,
    version: manifest.version,
    permissions: manifest.permissions ?? [],
    storage: {
      accepts: manifest.storage?.accepts ?? ['core'],
      ...(manifest.storage?.preferred ? { preferred: manifest.storage.preferred } : {}),
    },
    manifest,
    manifestText: text,
    packageDir: input.packageDir,
    form: 'source',
  };
}
