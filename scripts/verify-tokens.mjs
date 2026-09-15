#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * verify-tokens：主题令牌轻量 lint（任务第七条「选最轻方案」——node 单文件，零依赖）。
 * 扫描 apps/ packages/ modules/ services/ deploy/（排除 node_modules/ dist/ .deploy/ coverage/、
 * 任意层级 test/ 与 __tests__/ 目录、*.test.* 与 *.spec.* 测试文件——用例里的 issue 引用
 * 与颜色夹具不是生产样式，此前 `#139` 之类的引用被误判为裸颜色值），
 * 只处理 *.vue *.ts *.css *.html。
 *
 * 规则一（裸值）：生产源码不得有裸 hex（#[0-9a-fA-F]{3,8}）与裸 rgb(/rgba( 颜色值；
 *   豁免：apps/shell/src/tokens.css（:root 令牌定义与 @theme 映射允许值）、
 *         packages/contracts/src/theme-tokens.json（默认主题包数据）。
 * 规则二（var 白名单）：所有 var(--xxx) 引用必须在白名单 = 契约白名单
 *   （从 packages/contracts/src/theme-tokens.json 派生：'--' + 键.replaceAll('.', '-')）
 *   ∪ tokens.css 已声明的内部令牌（动效 duration/ease 等：平台自己的 CSS 声明了值，
 *   壳/组件内引用可解析；但模块页引它们仍会被部署期体检红——通道注入只投契约令牌）；
 *   豁免文件同样检查（tokens.css 内 --unself-focus-ring: 2px solid var(--unself-color-primary) 必须通过）。
 * 规则三（裸时长，#191 F1）：CSS 声明里不得出现时间字面量（如 `animation: u-spin 0.8s`）——
 *   动效参数只出自令牌 --unself-duration-*；只查 .css 全体 与 .vue 的 <style> 区块，
 *   注释/脚本/模板内的文字（如文档里写「约 210ms」）不算；tokens.css 是取值定义处，豁免。
 *
 * 输出：逐条 `文件:行号: 原因`；有违规 exit 1，零违规静默 exit 0。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // scripts/ 的上一级 = 仓库根
const SCAN_DIRS = ['apps', 'packages', 'modules', 'services', 'deploy'];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', '.deploy', 'coverage', 'test', '__tests__']);
const FILE_EXTS = new Set(['.vue', '.ts', '.css', '.html']);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const RULE1_EXEMPT = new Set(['apps/shell/src/tokens.css', 'packages/contracts/src/theme-tokens.json']);
/** 规则三豁免：tokens.css 是时长取值的定义处（其余文件只准引用令牌）。 */
const RULE3_EXEMPT = new Set(['apps/shell/src/tokens.css']);
const CONTRACT_PACKAGE = 'packages/contracts/src/theme-tokens.json';

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /rgba?\(/g;
const VAR_RE = /var\(\s*(--[a-zA-Z0-9-]+)/g;
/** 规则三：时间字面量（`0.8s` / `450ms`）——CSS 区段内出现即违规。 */
const TIME_RE = /\b\d+(?:\.\d+)?m?s\b/g;

/** 白名单：契约白名单 ∪ tokens.css 已声明的内部令牌（'--' + 点号键.replaceAll('.', '-')）。 */
function loadVarWhitelist() {
  const pkg = join(ROOT, CONTRACT_PACKAGE);
  if (!existsSync(pkg)) {
    throw new Error(`verify-tokens：契约主题包缺失 ${CONTRACT_PACKAGE}（应随 packages/contracts 提供）`);
  }
  const map = JSON.parse(readFileSync(pkg, 'utf8'));
  const whitelist = new Set(Object.keys(map).map((k) => `--${k.replaceAll('.', '-')}`));
  // 平台内部令牌：tokens.css 中已声明（--unself-*）的即视为“平台提供了值”
  const tokensCss = join(ROOT, 'apps/shell/src/tokens.css');
  if (existsSync(tokensCss)) {
    const css = readFileSync(tokensCss, 'utf8');
    for (const m of css.matchAll(/--unself-[a-zA-Z0-9-]+\s*:/g)) {
      whitelist.add(m[0].replace(/\s*:$/, ''));
    }
  }
  return whitelist;
}

/** 字符偏移 → 1 基行号。 */
function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

/**
 * 剥离注释（块注释/整行 // 注释/HTML 注释），换行保留 → 行号不变。
 * 文档中的示例写法（如 `var(--xxx`）不是真实引用，不应触发规则。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 取 CSS 文本（保行号：非 CSS 区段用「空格顶位、换行保留」顶掉）——规则三只在样式声明里判时长。
 * .css 全文；.vue 只取 <style> 区块；其余扩展名返回 null（不适用）。
 */
function cssText(relPath, text) {
  const ext = extname(relPath);
  if (ext === '.css') return text;
  if (ext !== '.vue') return null;
  /** 用空格顶掉非 CSS 字符，但保留换行（行号不乱）。 */
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let idx = 0;
  for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    out += blank(text.slice(idx, m.index));
    const openLen = m[0].indexOf('>') + 1;
    out += blank(m[0].slice(0, openLen)) + m[1];
    out += blank(m[0].slice(openLen + m[1].length));
    idx = m.index + m[0].length;
  }
  return out + blank(text.slice(idx));
}

/** 单文件 lint：返回违规清单（每条「文件:行号: 原因」）。relPath 用 / 分隔的仓库相对路径。 */
export function lintFile(relPath, text, varWhitelist) {
  const code = stripComments(text);
  const violations = [];
  // 规则一：裸值（豁免文件除外）
  if (!RULE1_EXEMPT.has(relPath)) {
    for (const m of code.matchAll(HEX_RE)) {
      violations.push(`${relPath}:${lineOf(code, m.index)}: 裸颜色值 ${m[0]}（样式只出自主题令牌）`);
    }
    for (const m of code.matchAll(RGB_RE)) {
      violations.push(`${relPath}:${lineOf(code, m.index)}: 裸颜色值 ${m[0]}（样式只出自主题令牌）`);
    }
  }
  // 规则二：var 白名单（豁免文件同样查）
  for (const m of code.matchAll(VAR_RE)) {
    const name = m[1];
    if (!varWhitelist.has(name)) {
      violations.push(`${relPath}:${lineOf(code, m.index)}: 未解析令牌 ${name}（不在契约白名单）`);
    }
  }
  // 规则三：裸时长（#191 F1：动效参数只出自令牌）
  const css = RULE3_EXEMPT.has(relPath) ? null : cssText(relPath, code);
  if (css) {
    for (const m of css.matchAll(TIME_RE)) {
      violations.push(
        `${relPath}:${lineOf(css, m.index)}: 裸时长 ${m[0]}（动效参数只出自 --unself-duration-* 令牌）`,
      );
    }
  }
  return violations;
}

/** 深度遍历文件（按目录名排除噪声目录，含任意层级 test/ 与 __tests__/）。 */
function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** 全仓 lint：扫描目录树 + 契约主题包（.json 不在常规扩展内，但规则二要求查其 var 引用）。 */
export function lintRepo(rootDir = ROOT) {
  const varWhitelist = loadVarWhitelist();
  const violations = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(rootDir, dir);
    if (!existsSync(abs)) continue;
    for (const file of walkFiles(abs)) {
      const rel = relative(rootDir, file).split(sep).join('/');
      if (!FILE_EXTS.has(extname(rel))) continue;
      if (TEST_FILE_RE.test(rel)) continue;
      violations.push(...lintFile(rel, readFileSync(file, 'utf8'), varWhitelist));
    }
  }
  // 契约主题包不满足扩展过滤，单独按规则二查（--unself-focus-ring 一行必须通过）
  const pkg = join(rootDir, CONTRACT_PACKAGE);
  if (existsSync(pkg)) {
    violations.push(...lintFile(CONTRACT_PACKAGE, readFileSync(pkg, 'utf8'), varWhitelist));
  }
  return violations;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const violations = lintRepo();
  if (violations.length > 0) {
    for (const v of violations) console.log(v);
    process.exit(1);
  }
}
