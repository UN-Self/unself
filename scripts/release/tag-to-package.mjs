#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * tag → 待发布包（决策 #79「tag 即版本」的唯一实现点）。
 *
 * 契约（W5 预期行为清单 E1–E3）：
 * - tag 必须是四种前缀之一：`sdk-v*` / `hello-v*` / `chat-v*` / `installer-v*`
 * - 版本 = tag 去掉 `<name>-v` 后的部分，必须是严格 semver `x.y.z`（可带 -prerelease）
 * - 前缀不认识 / 版本不合法 → **直接失败**（人话错误，绝不静默跳过）
 *
 * 纯函数，可单测（见 packages/installer/test/release-tag.test.ts）。
 * 用法（CI）：node scripts/release/tag-to-package.mjs "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
 */
import { pathToFileURL } from 'node:url';

/** tag 前缀 → 发布目标。`packDir` 指「构建后可用于打包/发布的目录」。 */
export const RELEASE_TARGETS = {
  sdk: { package: '@unself/sdk', kind: 'workspace', dir: 'packages/module-sdk' },
  installer: { package: '@unself/installer', kind: 'workspace', dir: 'packages/installer' },
  hello: { package: '@unself/hello', kind: 'module', id: 'hello', dir: 'packages/installer/dist/artifacts/modules/hello' },
  chat: { package: '@unself/chat', kind: 'module', id: 'chat', dir: 'packages/installer/dist/artifacts/modules/chat' },
};

/** 严格 semver（允许预发布段与构建元数据）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} tag
 * @returns {{ name: string, package: string, kind: string, dir: string, id?: string, version: string }}
 */
export function parseReleaseTag(tag) {
  const m = /^([a-z]+)-v(.+)$/.exec(String(tag ?? '').trim());
  if (!m) {
    throw new Error(
      `tag 形式不认识：「${tag}」。支持的四种：sdk-v0.1.0 / hello-v0.1.0 / chat-v0.1.0 / installer-v0.2.0`,
    );
  }
  const [, name, version] = m;
  const target = RELEASE_TARGETS[name];
  if (!target) {
    throw new Error(
      `tag 前缀「${name}」不是可发布的包。可选：${Object.keys(RELEASE_TARGETS).join(' / ')}`,
    );
  }
  if (!SEMVER_RE.test(version)) {
    throw new Error(`版本号不合法：「${version}」（须形如 0.1.0 或 0.2.0-next.1）`);
  }
  return { name, version, ...target };
}

/** 输出 GITHUB_OUTPUT 行（CI 用）。 */
export function toGithubOutput(result) {
  const lines = [
    `name=${result.name}`,
    `package=${result.package}`,
    `kind=${result.kind}`,
    `dir=${result.dir}`,
    `version=${result.version}`,
  ];
  if (result.id) lines.push(`id=${result.id}`);
  return lines.join('\n') + '\n';
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const result = parseReleaseTag(process.argv[2] ?? process.env.GITHUB_REF_NAME);
    process.stdout.write(toGithubOutput(result));
    process.stderr.write(`待发布：${result.package}@${result.version}（来源目录 ${result.dir}）\n`);
  } catch (e) {
    process.stderr.write(`发布失败：${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
