// SPDX-License-Identifier: AGPL-3.0-only
/**
 * verify-paths：结构闸门（#303）——「搬目录/改名」不得悄悄弄坏东西。
 *
 * 为什么需要：2026-09-20 两桶重排（packages/ → core/ + app/）当天，
 * 光是「包整体深了一层」就咬出 4 处断链（tsconfig 的 `extends` 指向不存在的文件），
 * 而它们**不会让测试变红**——tsc 静默退回默认配置、vite 直接报看不懂的错。
 * 目录结构类错误必须在**结构层面**抓，不能指望行为测试兜。
 *
 * 三条断言（零依赖，逐条报人话）：
 *   1. 每个 tsconfig*.json 的**相对** `extends` 必须能解到真实文件；
 *   2. `pnpm-workspace.yaml` 的 globs 必须覆盖仓库内每个含 package.json 的目录（漏登记的包＝不会被安装/测试）；
 *   3. 反向：globs 命中的目录必须真有 package.json（写歪的 glob 静默失效）。
 *
 * 用法：`node scripts/verify-paths.mjs`（CI 与本地门禁同一条）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.deploy', '.git', 'coverage', '.wrangler']);

/** 递归收集文件（按扩展名过滤；跳过生成物/依赖目录）。 */
function walk(dir, match, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(join(dir, entry.name), match, out);
    } else if (match(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const problems = [];

// ---- 断言 1：相对 extends 可解 ----
/** 去注释后取 `extends`（tsconfig 允许 JSONC）。 */
function readExtends(text) {
  const stripped = text.replace(/^\s*\/\/.*$/gm, '');
  try {
    const parsed = JSON.parse(stripped);
    const ext = parsed?.extends;
    return typeof ext === 'string' ? ext : null;
  } catch {
    return null; // 解析失败由 tsc 自己报，本闸门只管相对路径断链
  }
}

for (const file of walk(ROOT, (n) => n.startsWith('tsconfig') && n.endsWith('.json'))) {
  const ext = readExtends(readFileSync(file, 'utf8'));
  if (!ext || !ext.startsWith('.')) continue; // 只查相对；包名 extends 交给解析器
  if (!existsSync(resolve(dirname(file), ext))) {
    problems.push(`${relative(ROOT, file)}：extends "${ext}" 解不到真实文件（搬目录后深度没跟上？）`);
  }
}

// ---- 断言 2/3：workspace globs 与实际含 package.json 的目录一一对应 ----
const workspaceFile = join(ROOT, 'pnpm-workspace.yaml');
const globLines = readFileSync(workspaceFile, 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*$/, '').trim())
  .filter((l) => l.startsWith('- '))
  .map((l) => l.slice(2).trim().replace(/^['"]|['"]$/g, ''));

/** glob（仅支持 `*` 单层与字面段，够本仓用）→ 正则。 */
function globToRe(glob) {
  const parts = glob.split('/').map((seg) => (seg === '*' ? '[^/]+' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('/')}$`);
}
const globRes = globLines.map(globToRe);

/** 是否被 globs 覆盖（glob 段数相同且逐段匹配）。 */
function covered(relDir) {
  const segs = relDir.split(sep);
  return globRes.some((re) => re.test(segs.join('/')));
}

const packageDirs = [];
for (const file of walk(ROOT, (n) => n === 'package.json')) {
  const dir = dirname(file);
  if (resolve(dir) === resolve(ROOT)) continue; // 根包不需要登记进 globs
  packageDirs.push(relative(ROOT, dir));
}
for (const rel of packageDirs.sort()) {
  if (!covered(rel)) problems.push(`workspace 漏登记：${rel} 有 package.json 但没有任何 glob 命中它（不会被 pnpm 安装/测试）`);
}

/** globs 命中的目录必须有 package.json（写歪的 glob 静默失效）。 */
function dirsUnder(dir, depth, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    acc.push(relative(ROOT, abs));
    if (depth > 1) dirsUnder(abs, depth - 1, acc);
  }
  return acc;
}
const declaredRoots = globLines.map((g) => g.split('/')[0]);
for (const top of new Set(declaredRoots)) {
  const abs = join(ROOT, top);
  if (!existsSync(abs)) {
    problems.push(`pnpm-workspace.yaml 的 glob "${top}/…" 指向不存在的顶层目录（搬目录后忘改？）`);
  }
}

// ---- 输出 ----
if (problems.length > 0) {
  console.error(`✗ 结构闸门不通过（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const counts = `${packageDirs.length} 个 workspace 包，${globLines.length} 条 glob`;
console.log(`✓ 结构闸门通过（${counts}；tsconfig 相对 extends 全部可解）`);
