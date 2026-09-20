#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 发布前把 `workspace:` 协议依赖改写成真实版本号（issue #286 / 决策 #79）。
 *
 * 为什么需要：`npm publish` **不改写** `workspace:`（`pnpm publish` 才会），而我们的发布路径
 * 走 `npm publish`（npm 的 Trusted Publishing/OIDC 是官方支持的路径）。若原样发布，
 * 消费者安装会得到 `Unsupported URL Type "workspace:"` —— 即「官方模块预装」直接失效。
 * 实测（pnpm 11.24.0）：`npm pack` → `{"@unself/hello":"workspace:*"}`；`pnpm pack` → `{"@unself/hello":"0.1.0"}`。
 *
 * 改写规则（与 pnpm 一致）：
 *   `workspace:*`   → 精确版本            `workspace:^`   → `^<version>`
 *   `workspace:~`   → `~<version>`        `workspace:<range>` → 该 range 原样（本地校验交给 pnpm install）
 *
 * 用法（CI）：node scripts/release/pin-workspace-deps.mjs <包目录>
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKSPACE_SPEC_RE = /^workspace:(.*)$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** `workspace:<rest>` + 本地版本 → 发布用 range。非 workspace 协议原样返回。 */
export function rewriteWorkspaceSpec(spec, localVersion) {
  const m = WORKSPACE_SPEC_RE.exec(String(spec));
  if (!m) return spec;
  const rest = m[1];
  if (rest === '*' || rest === '') return localVersion;
  if (rest === '^') return `^${localVersion}`;
  if (rest === '~') return `~${localVersion}`;
  return rest; // 显式 range 原样（如 workspace:^1.2.3）
}

/** 对一份 package.json 对象做改写，返回 { pkg, changed[] }。纯函数，便于单测。 */
export function pinWorkspaceDeps(pkg, resolveVersion) {
  const changed = [];
  const next = { ...pkg };
  for (const field of DEP_FIELDS) {
    const deps = next[field];
    if (!deps || typeof deps !== 'object') continue;
    const out = {};
    for (const [name, spec] of Object.entries(deps)) {
      if (!WORKSPACE_SPEC_RE.test(String(spec))) {
        out[name] = spec;
        continue;
      }
      const version = resolveVersion(name);
      if (!version) throw new Error(`依赖 ${name} 声明了 ${spec}，但在本 workspace 里找不到它的版本`);
      const pinned = rewriteWorkspaceSpec(spec, version);
      out[name] = pinned;
      changed.push(`${field}.${name}: ${spec} → ${pinned}`);
    }
    next[field] = out;
  }
  return { pkg: next, changed };
}

/**
 * 扫 workspace 目录，建立 包名 → { version, dir }。
 * 目录来源 = `pnpm-workspace.yaml` 的 patterns（**不硬编码**：漏一个目录会让发布前置直接失败，
 * 例如 `deploy/*` 那种只出现在 yaml 里的目录）。`*` 按「一层目录」展开。
 */
export async function collectWorkspaceVersions(root) {
  const yamlPath = join(root, 'pnpm-workspace.yaml');
  const patterns = existsSync(yamlPath)
    ? (await readFile(yamlPath, 'utf8'))
        .split('\n')
        .map((l) => /^\s*-\s*(.+?)\s*$/.exec(l)?.[1])
        .filter((v) => Boolean(v) && !v.startsWith('packages:'))
    : [];
  const map = new Map();
  for (const pattern of patterns) {
    const dirs = [join(root, pattern)];
    // 支持 `a/*/b` 这类一层通配（workspace 里只用到一层）
    if (pattern.includes('*')) {
      const [head, ...rest] = pattern.split('/*');
      const headDir = join(root, head);
      if (!existsSync(headDir)) continue;
      dirs.length = 0;
      for (const d of await readdir(headDir, { withFileTypes: true })) {
        if (d.isDirectory()) dirs.push(join(headDir, d.name, ...rest));
      }
    }
    for (const dir of dirs) {
      const pj = join(dir, 'package.json');
      if (!existsSync(pj)) continue;
      const parsed = JSON.parse(await readFile(pj, 'utf8'));
      if (parsed.name && parsed.version) map.set(parsed.name, { version: parsed.version, dir });
    }
  }
  return map;
}

/** CLI：改写 <包目录>/package.json 里的 workspace: 协议（原地写回）。 */
export async function pinPackageDir(pkgDir, root) {
  const pj = join(pkgDir, 'package.json');
  const pkg = JSON.parse(await readFile(pj, 'utf8'));
  const versions = await collectWorkspaceVersions(root);
  const { pkg: next, changed } = pinWorkspaceDeps(pkg, (name) => versions.get(name)?.version);
  if (changed.length === 0) {
    process.stderr.write(`无需改写：${pkg.name} 没有 workspace: 协议依赖\n`);
    return [];
  }
  await writeFile(pj, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  for (const line of changed) process.stderr.write(`改写 ${line}\n`);
  return changed;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const pkgDir = process.argv[2];
  if (!pkgDir) {
    process.stderr.write('用法：node scripts/release/pin-workspace-deps.mjs <包目录>\n');
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    await pinPackageDir(pkgDir, root);
  } catch (e) {
    process.stderr.write(`发布前置失败：${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
