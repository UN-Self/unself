// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 入口（main）：装配器交互化（PRODUCT_SPEC §5.5 ①-⑥）。
 * 第一屏 token 深链接 → 域名三选/模块确认（TTY）→ 九步进度（[i/9] + 失败三要素）
 * → 收尾「下一步」指引。优先级 CLI > 交互 > 配置文件；非 TTY 无参数 = 静默走配置（CI 安全）。
 * token 粘贴值只留在本次进程内存（喂给 wrangler 环境变量），不落盘不写 shell rc。
 * 装配主流程 = runNineSteps 整包调用，行为与既有部署完全一致；本文件只做交互编排与输出。
 */
import { runNineSteps, type Summary } from './steps';
import { realWrangler } from './wrangler';
import { loadUnselfConfig, type UnselfConfig } from './config';
import {
  buildTokenDeepLink,
  buildTokenFirstScreen,
  chooseDomain,
  createAsker,
  isTty,
  parseCliArgs,
  parseModulesInput,
  pickTokenDecision,
  resolveDomainChoice,
  TOKEN_PERMISSION_TABLE,
} from './interactive';
import { progressTracker } from './progress';

const TOTAL_STEPS = 9;

/** 交互结果只改本次运行的内存副本，不回写 unself.config.jsonc（结构不变）。 */
function applyDecision(config: UnselfConfig, domain: string | null, modulesOverride: string[] | null): UnselfConfig {
  return {
    ...config,
    domain: domain ?? '',
    modules: modulesOverride ?? config.modules,
  };
}

/** 读一行终端输入（readline 注入点；全进程共用一个 asker，避免反复开关 stdin 丢缓冲）。 */
interface Asker {
  ask: (q: string) => Promise<string>;
  close: () => void;
}

function makeAsker(): Asker {
  let instance: Asker | null = null;
  return {
    ask: (q) => (instance ??= createAsker()).ask(q),
    close: () => instance?.close(),
  };
}

export async function main(argv: string[] = []): Promise<Summary> {
  const rootDir = process.cwd();
  const cli = parseCliArgs(argv);
  const tty = isTty();
  const out = (line: string) => console.log(line);
  const asker = makeAsker();

  // ---- 第一屏：token 检测 + CF 深链接（§5.5 ①）----
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    for (const line of buildTokenFirstScreen({
      deepLink: buildTokenDeepLink(),
      permissionTable: TOKEN_PERMISSION_TABLE,
      tty,
    })) {
      out(line);
    }
    if (pickTokenDecision(tty) === 'paste') {
      const pasted = (await asker.ask('粘贴 token 回车继续，或 Ctrl+C 后 export 重跑 → ')).trim();
      if (!pasted) {
        out('未输入 token：退出。重跑本命令可随时再来（幂等）。');
        process.exitCode = 1;
        throw new Error('未提供 CLOUDFLARE_API_TOKEN');
      }
      process.env.CLOUDFLARE_API_TOKEN = pasted; // 仅本次进程内存
    } else {
      process.exitCode = 1;
      throw new Error('非交互终端无法粘贴 token：请先 export CLOUDFLARE_API_TOKEN=... 后重跑');
    }
  }

  console.log('Unself · deploy/cloudflare 幂等九步装配');
  console.log(`仓库根：${rootDir}`);

  // ---- 域名三选 + 模块确认（§5.5 ②③；CLI > 交互 > 配置文件）----
  const config = await loadUnselfConfig(rootDir);
  const decision = await resolveDomainChoice({
    cli,
    configDomain: config.domain,
    tty,
    interactive: () => chooseDomain({ ask: (q) => asker.ask(q), out }),
  });
  let modulesOverride: string[] | null = cli.modules ?? null;
  if (!cli.yes && tty && cli.modules === undefined) {
    const candidates = config.modules;
    out('② 启用模块（逗号分隔，回车=配置文件值）：');
    out(`  候选：${candidates.length > 0 ? candidates.join('、') : '（配置为空 = 全停用）'}`);
    for (let tries = 0; tries < 2; tries++) {
      const raw = await asker.ask('→ 回车=默认 ');
      const parsed = parseModulesInput(raw, candidates);
      if (parsed.invalid.length > 0) {
        out(`  未知模块：${parsed.invalid.join('、')}（候选：${candidates.length > 0 ? candidates.join('、') : '无'}）`);
        continue;
      }
      modulesOverride = parsed.ids;
      break;
    }
  }
  const effective = applyDecision(config, decision.domain, modulesOverride);
  asker.close(); // 交互终点：后续九步不再读终端
  out('──────────── 将装配 ────────────');
  out(`  域名   ${effective.domain || 'workers.dev 免费域名（自动分配）'}`);
  out(`  模块   ${effective.modules.length > 0 ? effective.modules.join('、') : '（全停用）'}    存储   ${effective.storage.provider === 'r2' ? `R2 自动创建（${effective.storage.bucket}）` : `外部 S3（${effective.storage.endpoint}）`}`);
  out('提示：本命令可随时重跑，幂等收敛，不会重复创建资源。');

  // ---- 九步进度（§5.5 ④）：每步 [i/9]……，失败 ✗ + 三要素 ----
  const tracker = progressTracker({ total: TOTAL_STEPS, out });
  let summary: Summary;
  try {
    summary = await runNineSteps({
      rootDir,
      wrangler: realWrangler(rootDir),
      reporter: tracker.reporter,
      configOverride: effective,
    });
    tracker.complete();
  } catch (err) {
    tracker.fail(err);
    out('\n装配失败。本命令可随时重跑：幂等收敛，不会重复创建资源。');
    throw err;
  }

  // ---- 收尾屏「下一步」指引（§5.5 ⑤）----
  console.log('\n━━━━━━━━━━ 装配完成 ✓ ━━━━━━━━');
  console.log(`实例地址：${summary.baseUrl}`);
  console.log(`core Worker：${summary.core.name}`);
  for (const m of summary.modules) {
    console.log(`模块 ${m.id}：/m/${m.id}/*（配置 ${m.config}）`);
  }
  console.log('\n下一步：');
  if ('setupUrl' in summary.setup) {
    console.log('  ① 打开一次性设置链接（仅部署者可见，用后即封死）：');
    console.log(`     ${summary.baseUrl}${summary.setup.setupUrl}`);
    console.log('  ② 设置第一个管理员（默认：用户名+密码；也可接团队 OIDC，可选）');
  } else {
    console.log('  ① 实例已完成 setup（激活入口已永久封死），直接登录即可');
  }
  console.log('  ③ 登录 → 管理台 → 邀请 → 生成链接拉人');
  console.log('  ④ 想要团队邮箱？设置 → 邮件服务（可选，随时配）');
  return summary;
}
