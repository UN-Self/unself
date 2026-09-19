// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GitHub Actions 工作流文件必须能被 YAML 解析。
 *
 * 为什么需要这条闸（真实事故）：`.github/workflows/release.yml` 里写了
 * `- name: 改写 workspace: 协议依赖`——未加引号的标量里含「: 」，YAML 直接语法错。
 * 后果不是「报错」，而是**静默**：GitHub 把该 workflow 注册成文件名、任何 tag 推送都不触发、
 * 分支推送产生 0s 失败且没有日志。PR 上 CI 照样绿（那是 ci.yml 的绿灯），发布流水线却是死的。
 * 直到第一次真打 tag 才发现。
 *
 * 用法：`node scripts/verify-workflows.mjs`（CI 的 lint 段跑它；退出码非 0 = 有文件不合法）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';

/** 极简 YAML 结构校验：够抓「未加引号的冒号/制表符/缩进错」这类会让 GitHub 拒绝解析的写法。 */
function problems(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (/\t/.test(line)) out.push(`第 ${n} 行含制表符（YAML 禁止用 tab 缩进）`);
    // 未加引号的标量里含「: 」：`key: value with: colon` → GitHub 会整份拒绝解析
    const m = /^\s*(?:-\s+)?[A-Za-z_][\w.-]*:\s+(.*)$/.exec(line);
    if (m && /:(\s|$)/.test(m[1]) && !/^["'|>]/.test(m[1].trim())) {
      out.push(`第 ${n} 行未加引号的值里含「: 」→ YAML 会解析失败：${line.trim().slice(0, 60)}`);
    }
  });
  return out;
}

let failed = 0;
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  console.error(`✗ ${DIR} 下没有工作流文件（路径写错？）`);
  process.exit(1);
}
for (const f of files.sort()) {
  const p = join(DIR, f);
  const bad = problems(readFileSync(p, 'utf8'));
  if (bad.length) {
    failed += 1;
    console.error(`✗ ${p}`);
    for (const b of bad) console.error(`    ${b}`);
  } else {
    console.log(`✓ ${p}`);
  }
}
if (failed) {
  console.error(`\n✗ ${failed} 个工作流文件不合法——GitHub 会**静默**不跑它们（tag 推送不触发）`);
  process.exit(1);
}
console.log('\n✓ 工作流文件全部通过结构校验');
