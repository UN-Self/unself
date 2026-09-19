// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 入口（main）：装配器交互化（PRODUCT_SPEC §5.5 ①-⑥）。
 * 第一屏 token 深链接 → 域名三选/模块确认（TTY）→ 九步进度（[i/9] + 失败三要素）
 * → 收尾「下一步」指引。优先级 CLI > 交互 > 配置文件；非 TTY 无参数 = 静默走配置（CI 安全）。
 * token 粘贴值只留在本次进程内存（喂给 wrangler 环境变量），不落盘不写 shell rc。
 * 装配主流程 = runNineSteps 整包调用，行为与既有部署完全一致；本文件只做交互编排与输出。
 */
import { runNineSteps, type Summary } from './steps';
import { loadUnselfConfig, moduleIds, normalizeModuleEntries, type NormalizedModuleEntry, type UnselfConfig } from './config';
import { CredentialsMissingError, credentialsMissingMessage, resolveAuth } from './auth';
import { probePermissions } from './permissions';
import {
  authPreflight,
  buildTokenDeepLink,
  buildTokenFirstScreen,
  chooseDomain,
  createAsker,
  domainProblem,
  isTty,
  oauthCallbackReachable,
  parseCliArgs,
  parseModulesInput,
  resolveDomainChoice,
  TOKEN_PERMISSION_TABLE,
} from './interactive';
import { progressTracker } from './progress';

const TOTAL_STEPS = 9;

/** 交互结果只改本次运行的内存副本，不回写 unself.config.jsonc（结构不变）。**条目原样保留来源**（#77：官方模块也是 npm 串，交互面只确认启用与否）。 */
function applyDecision(config: UnselfConfig, domain: string | null, modulesOverride: NormalizedModuleEntry[] | null): UnselfConfig {
  return {
    ...config,
    domain: domain ?? '',
    modules: modulesOverride ?? normalizeModuleEntries(config.modules),
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
  const noBrowser = !oauthCallbackReachable(); // 只探 2 项之二（决策 #67）；WSL 就是 Linux，不设分支

  // ---- 开跑前凭证收口（§5.5 ①前置，#246）：resolveAuth 统一收口，先拦后跑 ----
  // 三分支互斥穷尽：env token 直通；OAuth 借用成功→写入本次进程内存（引擎 defaultClient 复用）；
  // 都没有 → TTY 保留粘贴（bin.ts 已掩码采集，此处兜 tsx 直跑）/ 非 TTY 打第一屏深链接后退出（不卡死）。
  // 走到横幅时必有凭证，旧的「第一屏 + pickTokenDecision」第二道流程整体删除（#246 收口）。
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    const cred = await resolveAuth({ log: out });
    if (cred) {
      process.env.CLOUDFLARE_API_TOKEN = cred.token; // 仅本次进程内存；令牌不落盘不进日志
      if (cred.warning) out(cred.warning);
    } else if (tty) {
      out('未找到可用凭证（wrangler OAuth 借用不可用）。');
      out('把 token 粘贴到下面回车继续（只留在本次进程内存，不落盘），或 Ctrl+C 后 export 重跑：');
      const pasted = (await asker.ask('粘贴 token 回车继续 → ')).trim();
      if (!pasted) {
        out('未输入 token：退出。重跑本命令可随时再来（幂等）。');
        process.exitCode = 1;
        throw new Error('未提供 CLOUDFLARE_API_TOKEN');
      }
      process.env.CLOUDFLARE_API_TOKEN = pasted; // 仅本次进程内存
    } else {
      // 非 TTY 且 OAuth 借用失败：无浏览器环境时补「API Token/设备码」人话指引，不卡死（不做设备码实现，只指路）。
      if (noBrowser) out('无浏览器环境：走 API Token（深链接 + 密码框/Web 向导）或设备码。');
      for (const line of buildTokenFirstScreen({ deepLink: buildTokenDeepLink(), permissionTable: TOKEN_PERMISSION_TABLE, tty: false })) {
        out(line);
      }
      process.exitCode = 1;
      // 退出文案保持 CI 既定语义（bin.test 断言的是这一行）
      throw new Error('非交互终端无法粘贴 token：请先 export CLOUDFLARE_API_TOKEN=... 后重跑');
    }
  }

  console.log('Unself · deploy/cloudflare 幂等九步装配');
  console.log(`仓库根：${rootDir}`);

  // ---- 开跑前权限自检（#246 §5.5 ①前置；authPreflight 是 main 与 --check-auth 的共用编排）----
  // 凭证已就绪（env token / OAuth 借用 / TTY 粘贴）：四探全绿才继续装配。
  {
    const probe = await authPreflight({
      resolveAuth: () => resolveAuth({ log: out }),
      probePermissions: (client) => probePermissions(client, { domain: cli.domain }),
      log: out,
      out,
    });
    if (probe.outcome === 'no-credentials') {
      process.exitCode = 1;
      throw new CredentialsMissingError(credentialsMissingMessage());
    }
    if (probe.outcome === 'missing') {
      out('开跑前拦截：先补权限（深链接重建 token 或 `wrangler login` 重授权）再重跑；');
      out(`  深链接：${probe.deepLink}`);
      process.exitCode = 1;
      throw new Error('权限自检未通过（缺项见上），开跑前拦下');
    }
  }

  // ---- 域名三选 + 模块确认（§5.5 ②③；CLI > 交互 > 配置文件）----
  const config = await loadUnselfConfig(rootDir);
  const configEntries = normalizeModuleEntries(config.modules);
  const decision = await resolveDomainChoice({
    cli,
    configDomain: config.domain,
    tty,
    interactive: () => chooseDomain({ ask: (q) => asker.ask(q), out }),
  });
  /** 启用条目覆写（#77：条目带 source，故按 config 条目筛选，不重建裸 id）。 */
  let modulesOverride: NormalizedModuleEntry[] | null = null;
  const selectByIds = (ids: string[]): NormalizedModuleEntry[] => {
    const wanted = new Set(ids);
    const unknown = ids.filter((id) => !configEntries.some((e) => e.id === id));
    if (unknown.length > 0) {
      throw new Error(
        `未知模块：${unknown.join('、')}（#77 起模块必须有来源：先在 unself.config.jsonc 的 modules 里写 { id, source }）`,
      );
    }
    return configEntries.filter((e) => wanted.has(e.id));
  };
  if (cli.modules !== undefined) modulesOverride = selectByIds(cli.modules);
  if (modulesOverride === null && !cli.yes && tty) {
    const candidates = moduleIds(configEntries);
    out('② 启用模块（逗号分隔，回车=配置文件值）：');
    out(`  候选：${candidates.length > 0 ? candidates.join('、') : '（配置为空 = 全停用）'}`);
    for (let tries = 0; tries < 2; tries++) {
      const raw = await asker.ask('→ 回车=默认 ');
      const parsed = parseModulesInput(raw, candidates);
      if (parsed.invalid.length > 0) {
        out(`  未知模块：${parsed.invalid.join('、')}（候选：${candidates.length > 0 ? candidates.join('、') : '无'}）`);
        continue;
      }
      modulesOverride = selectByIds(parsed.ids ?? []);
      break;
    }
  }
  const effective = applyDecision(config, decision.domain, modulesOverride);
  // 域名体检（#194 D3）：CLI --domain= 与配置文件 domain 两份入口在此统一拦截（九步内部
  // runNineSteps 还有一道同样检查，双保险；这里能在开屏前给出人话错误，不浪费一次构建）。
  if (effective.domain) {
    const problem = domainProblem(effective.domain);
    if (problem) {
      out(`域名体检未通过（来源：${decision.source === 'cli' ? '--domain= 参数' : decision.source === 'config' ? 'unself.config.jsonc 的 domain' : '交互输入'}）：`);
      out(`  ${problem}`);
      out('拼写错误重跑解决不了：改对输入再跑（本命令幂等，不会创建任何资源）。');
      process.exitCode = 1;
      throw new Error(`域名体检未通过：${problem}`);
    }
  }
  asker.close(); // 交互终点：后续九步不再读终端

  // --check-auth：探测与自检已在上面完成，到此即退出（0=自检通过，1=被拦；不装配、不进九步）。
  if (cli.checkAuth) {
    out('--check-auth：权限自检通过，可以开跑（未装配任何资源）。');
    out('──────────── 将装配（预览）────────────');
    // 预览必须与真正装配用同一份 effective（CLI/交互 > 配置文件）；
    // 且 #245 起 config.modules 可为对象条目（{id, source}），直接 join 会印 [object Object]——
    // effective.modules 已经过 moduleIds(normalizeModuleEntries(...)) 归一化。
    out(`  域名   ${effective.domain || 'workers.dev 免费域名（自动分配）'}`);
    out(`  模块   ${effective.modules.map((m) => m.id).join('、') || '（全停用）'}`);
    return {} as unknown as Summary;
  }

  out('──────────── 将装配 ────────────');
  out(`  域名   ${effective.domain || 'workers.dev 免费域名（自动分配）'}`);
    out(`  模块   ${effective.modules.length > 0 ? effective.modules.map((m) => m.id).join('、') : '（全停用）'}    存储   ${effective.storage.provider === 'r2' ? `R2 自动创建（${effective.storage.bucket}）` : `外部 S3（${effective.storage.endpoint}）`}`);
  out('提示：本命令可随时重跑，幂等收敛，不会重复创建资源。');

  // ---- 九步进度（§5.5 ④）：每步 [i/9]……，失败 ✗ + 三要素 ----
  const tracker = progressTracker({ total: TOTAL_STEPS, out });
  const summary: Summary = await (async () => {
    try {
      const s = await runNineSteps({
        rootDir,
        reporter: tracker.reporter,
        configOverride: effective,
      yes: cli.yes,
      });
      tracker.complete();
      return s;
    } catch (err) {
      tracker.fail(err);
      out('\n装配失败。本命令可随时重跑：幂等收敛，不会重复创建资源。');
      throw err;
    }
  })();

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
