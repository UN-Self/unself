// SPDX-License-Identifier: AGPL-3.0-only
/**
 * hello 模块清单加载（#349 U8 ③）：包内 manifest → 契约对象 → startDialHome({manifest})。
 *
 * 双轨查找（对齐 installer 的 readManifest 单轨判别，#243）：
 * - dist/manifest.json（发布形态）：构建脚本 build.mjs 在构建期从 manifest.yaml 生成
 *   （json 副本随包发布，npm tarball 安装形态没有 yaml）；
 * - 包根 manifest.yaml（仓库工作区源码形态）：用 @unself/contracts 的
 *   manifestFromYamlText 解析（workspace 内部包，bundle 进 dist/main.js 零运行时依赖）。
 *
 * 契约对象过 ModuleManifestSchema.parse（fail-fast）：清单坏 = 模块起不来比静默跑好
 * ——自报通道（POST /api/modules/connect-manifest）会把这份对象整份交给 core 校验，
 * 本地先 parse 一次把错误留在启动现场。
 */
import { readFile } from 'node:fs/promises';

import { ModuleManifestSchema, manifestFromYamlText, type ModuleManifest } from '@unself/contracts';

/** 包根（src/manifest.ts 与 dist/main.js 都是包内一级文件，一层 .. 即包根）。 */
function packageRoot(): string {
  // new URL('../', file://…/hello/src/manifest.ts) = file://…/hello/（相对解析把最后一段当文件名）
  return new URL('../', import.meta.url).pathname;
}

/** 按双轨优先级读 manifest 原文；都没有 → null（调用方决定降级语义）。 */
async function readManifestText(): Promise<{ text: string; json: boolean } | null> {
  const root = packageRoot();
  try {
    return { text: await readFile(`${root}dist/manifest.json`, 'utf8'), json: true };
  } catch {
    // 发布形态缺失（未构建/工作区直跑）→ yaml 轨
  }
  try {
    return { text: await readFile(`${root}manifest.yaml`, 'utf8'), json: false };
  } catch {
    return null;
  }
}

/**
 * 加载并校验模块清单；解析/校验失败抛错（启动现场 fail-fast）。
 * 文件缺失（如被裁剪的运行环境）返回 null——main.ts 据此降级为「不报 manifest」，
 * 不阻塞「只跑本地 HTTP」的零依赖自检形态。
 */
export async function loadModuleManifest(): Promise<ModuleManifest | null> {
  const source = await readManifestText();
  if (!source) return null;
  const candidate = source.json ? (JSON.parse(source.text) as unknown) : manifestFromYamlText(source.text);
  return ModuleManifestSchema.parse(candidate);
}
