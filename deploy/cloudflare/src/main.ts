// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 入口（main）：装配 → 九步 → 部署输出（末尾打印一次性 setup 链接，§5.5 ⑧）。
 */
import { runNineSteps, consoleReporter, type Summary } from './steps';
import { realWrangler } from './wrangler';

export async function main(_argv: string[] = []): Promise<Summary> {
  const rootDir = process.cwd();
  console.log('Unself · deploy/cloudflare 幂等九步装配');
  console.log(`仓库根：${rootDir}`);
  const summary = await runNineSteps({ rootDir, wrangler: realWrangler(rootDir), reporter: consoleReporter() });

  console.log('\n━━━━━━━━━━ 部署完成 ━━━━━━━━');
  console.log(`实例地址：${summary.baseUrl}`);
  console.log(`core Worker：${summary.core.name}`);
  for (const m of summary.modules) {
    console.log(`模块 ${m.id}：/m/${m.id}/*（配置 ${m.config}）`);
  }
  if ('setupUrl' in summary.setup) {
    console.log('\n⚠️  一次性 setup 激活链接（仅部署者可见，用后即封死）：');
    console.log(`   ${summary.baseUrl}${summary.setup.setupUrl}`);
    console.log('   打开链接 → OIDC 登录自己 → 该账号成为首个管理员。');
  } else {
    console.log('\n实例已完成 setup（激活入口已永久封死）。');
  }
  return summary;
}

