// SPDX-License-Identifier: AGPL-3.0-only
/** 从发布形态 dist/manifest.json 或源码形态 manifest.yaml 读取并校验 Calendar 清单。 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModuleManifestSchema, manifestFromYamlText, type ModuleManifest } from '@unself/contracts';

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

async function readManifestText(): Promise<{ text: string; json: boolean } | null> {
  const root = packageRoot();
  try {
    return { text: await readFile(join(root, 'dist', 'manifest.json'), 'utf8'), json: true };
  } catch {
    // 发布形态缺失：继续读源码形态。
  }
  try {
    return { text: await readFile(join(root, 'manifest.yaml'), 'utf8'), json: false };
  } catch {
    return null;
  }
}

export async function loadModuleManifest(): Promise<ModuleManifest | null> {
  const source = await readManifestText();
  if (!source) return null;
  const candidate = source.json ? (JSON.parse(source.text) as unknown) : manifestFromYamlText(source.text);
  return ModuleManifestSchema.parse(candidate);
}
