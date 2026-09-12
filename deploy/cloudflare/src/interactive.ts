// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 装配器交互决策（PRODUCT_SPEC §5.5 ①②③）：
 * 全部为纯函数或注入式 I/O（ask/out/rl），readline 只在 createAsker 里出现——
 * 测试注入 fake ask/out 即可覆盖 TTY/非 TTY 全部分支，不碰真实终端。
 * 优先级铁律：CLI > 交互 > 配置文件；非 TTY 无参数 = 静默走配置（CI 安全）。
 */
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';

/** CLI 参数（bin.ts 传入 process.argv.slice(2)）。 */
export interface CliArgs {
  domain?: string;
  modules?: string[];
  yes: boolean;
}

/** 解析 --domain=<d> / --modules=<a,b> / -y|--yes；未知参数忽略；重复参数后者胜。 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yes: false };
  for (const raw of argv) {
    if (raw === '-y' || raw === '--yes') {
      args.yes = true;
    } else if (raw.startsWith('--domain=')) {
      const v = raw.slice('--domain='.length).trim();
      if (v) args.domain = v;
    } else if (raw.startsWith('--modules=')) {
      const v = raw.slice('--modules='.length).trim();
      args.modules = v === '' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    }
    // 未知参数忽略（禁过度防御：不报错不枚举）
  }
  return args;
}

/**
 * 域名决策（§5.5 ②）：显式三选，非隐性回退。
 * config.modules 空数组是合法值（全停用），故交互覆盖用 null（= 不覆盖）区分。
 */
export interface DomainDecision {
  /** null = workers.dev 免费域（config.domain 留空语义）。 */
  domain: string | null;
  source: 'cli' | 'interactive' | 'config';
}

/**
 * 最终参数决策：
 * - CLI 设了 domain → 直接用（source=cli）；modules 同理。
 * - 未设 -y 且 TTY 且配置文件也没给 domain → 交互三选；modules 回车默认配置值。
 * - 其余（CI、-y、配置已有）→ 配置值；domain 空 → null（workers.dev）。
 */
export function resolveDomainChoice(input: {
  cli?: CliArgs;
  configDomain: string;
  tty: boolean;
  interactive: () => Promise<string | null>;
}): Promise<DomainDecision> {
  const { cli, configDomain, tty, interactive } = input;
  if (cli?.domain) return Promise.resolve({ domain: cli.domain, source: 'cli' });
  if (configDomain) return Promise.resolve({ domain: configDomain, source: 'config' });
  if (cli?.yes || !tty) return Promise.resolve({ domain: null, source: 'config' });
  return interactive().then((d) => ({ domain: d, source: 'interactive' }));
}

/**
 * 域名形态体检（#119③）：返回 null = 合法；否则给一句能直接照做的人话描述。
 * 规则：至少含一个点；每段为字母/数字/连字符，连字符不开头不结尾，不许有空段。
 */
export function domainProblem(domain: string): string | null {
  const d = domain.trim();
  if (!d) return '域名为空';
  if (!d.includes('.')) return `「${d}」不像完整域名：至少要带一个点（如 team.example.com），裸名字没法配 DNS`;
  for (const label of d.split('.')) {
    if (label === '') return '域名里有连续的点（空段）';
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      return `「${label}」这段不合法：每段只能用字母、数字、连字符（-），且连字符不能开头或结尾`;
    }
  }
  return null;
}

/** 域名三选交互（注入 ask/out；返回 null = workers.dev）。文案对齐 docs/deploy.md 第二步。 */
export async function chooseDomain(io: { ask: (q: string) => Promise<string>; out: (line: string) => void }): Promise<string | null> {
  const { ask, out } = io;
  out('① 团队入口域名：');
  out('  [1] workers.dev 免费域名（推荐起步，随时可换自有域）');
  out('  [2] 自有域名（需 DNS 已托管在 Cloudflare）');
  for (let tries = 0; tries < 2; tries++) {
    const raw = (await ask('→ [1] ')).trim();
    if (raw === '' || raw === '1') return null;
    if (raw === '2') {
      for (let t = 0; t < 2; t++) {
        const domain = (await ask('  输入域名（如 team.example.com）→ ')).trim();
        if (!domain) {
          out('  域名不能为空。');
          continue;
        }
        const problem = domainProblem(domain);
        if (problem) {
          out(`  ${problem}，请重输。`);
          continue;
        }
        return domain;
      }
      return null;
    }
    out(`  无效选项「${raw}」，请输入 1 或 2。`);
  }
  return null;
}

/**
 * 模块覆盖解析（§5.5 ③）：回车 = 沿用配置（null）；逗号分隔去重保序。
 * 非法 id（不在候选内）→ null + invalid 携带实际输入，调用方打印提示后重问/兜底。
 */
export function parseModulesInput(raw: string, available: string[]): { ids: string[] | null; invalid: string[] } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ids: null, invalid: [] };
  const parts = trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return { ids: null, invalid: [] };
  const known = new Set(available);
  const invalid = [...new Set(parts.filter((p) => !known.has(p)))];
  if (invalid.length > 0) return { ids: null, invalid };
  const ids = [...new Set(parts)];
  return { ids, invalid: [] };
}

/** token 第一屏决策：TTY → 粘贴；非 TTY → 打印人话后退出（exit 1 由调用方执行）。 */
export function pickTokenDecision(tty: boolean): 'paste' | 'exit' {
  return tty ? 'paste' : 'exit';
}

/** CF token 深链接（官方模板 URL 格式，硬编码权限集，§5.5 ①）。 */
const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'dns', type: 'edit' },
  { key: 'ssl_and_certificates', type: 'edit' },
] as const;

export function buildTokenDeepLink(name = 'unself-deploy'): string {
  const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
  url.searchParams.set('permissionGroupKeys', JSON.stringify(TOKEN_PERMISSIONS));
  url.searchParams.set('accountId', '*');
  url.searchParams.set('zoneId', 'all');
  url.searchParams.set('name', name);
  return url.toString();
}

/** 权限清单表（深链接格式失效时的退化输出，也与 README 权限清单对齐）。 */
export const TOKEN_PERMISSION_TABLE: string[] = [
  '  Account：Workers Scripts Edit、D1 Edit、R2 Edit',
  '  Zone（自有域名所属 zone）：Workers Routes Edit、DNS Edit、SSL and Certificates Edit',
];

/**
 * token 第一屏文案（不打印，返回行数组；对齐 docs/deploy.md 第一步样例）。
 * deepLink 传 null = 退化打印权限清单表。
 */
export function buildTokenFirstScreen(input: { deepLink: string | null; permissionTable: string[]; tty: boolean }): string[] {
  const { deepLink, permissionTable, tty } = input;
  const lines: string[] = [];
  lines.push('未检测到 CLOUDFLARE_API_TOKEN。');
  lines.push('需要一个 Cloudflare API Token（权限已为你预选，只需点两次）：');
  if (deepLink) {
    lines.push(`  ① 打开 ${deepLink}`);
  } else {
    lines.push('  ① 打开 https://dash.cloudflare.com/profile/api-tokens/create → Create Custom Token，按下面清单勾权限：');
    lines.push(...permissionTable);
  }
  lines.push('  ② 起名（如 unself-deploy）→ Continue → Create Token → 复制');
  lines.push('  ③ 重跑：export CLOUDFLARE_API_TOKEN=<粘贴> && node deploy/cloudflare/bin.ts');
  lines.push(tty ? '或直接把 token 粘贴到下面回车继续（只留在本次进程内存，不落盘）：' : '非交互终端无法粘贴 token：请先 export CLOUDFLARE_API_TOKEN=... 后重跑。');
  if (tty) lines.push('也可先 export CLOUDFLARE_API_TOKEN 再重跑（之后不用每次粘贴），粘贴仅本次有效。');
  return lines;
}

/**
 * 读一行终端输入（readline 注入点；全进程共用一个 asker）。
 *
 * 行缓冲队列：node:readline 在无 pending question 时到达的行会被「按键消费」（terminal
 * 键位处理），空闲后恢复提问会先吃掉一行甚至触发 pty EOF（真机实测）。故监听 'line'
 * 自建队列——先到的行排队，提问按序消费，宏任务间隙（如读配置文件）不再丢行。
 * EOF（Ctrl+D）或关闭后提问 → 返回空串，调用方走默认/退出分支。
 *
 * 回显卫生（#119②）：terminal:false 时 readline 自身不回显（逐字回显来自内核行规程），
 * 但提问间隙（读配置等宏任务空窗）到达的整行会在终端上留下一行残影，后续输出接在残影
 * 之后——即 #22 走查实录的「菜单回显残留」。处置：
 * ① readline 的 output 指向哑 sink：它的输出只发生在提问收尾/close（真机下尾写列归零
 *    + 清行转义），指哑后彻底不写屏，提示语由本包 ask 自行输出，视觉完全可控；
 * ② 空闲期入队的行（非 pending question）在 TTY→TTY 链路上补一次「上移 + 列归零 + 清行」
 *    （\x1b[1A\r\x1b[0K）把内核回显残影擦掉；提问期间的正常键入不擦，用户仍看得到自己刚输的内容。
 */
export interface Asker {
  ask: (q: string) => Promise<string>;
  close: () => void;
}

/** 流注入点（测试用 PassThrough 仿 stdin/stdout；缺省 = 真实终端）。 */
export interface AskerStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function createAsker(streams: AskerStreams = {}): Asker {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const inTty = (input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY === true;
  const outTty = (output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
  const rl = createInterface({ input, output: new PassThrough(), terminal: false });
  const queue: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  let closed = false;
  const eraseGhostLine = () => {
    if (inTty && outTty) output.write('\x1b[1A\r\x1b[0K');
  };
  rl.on('line', (line: string) => {
    const v = line.replace(/\r$/, '');
    const waiter = waiters.shift();
    if (waiter) {
      waiter(v);
    } else {
      eraseGhostLine(); // 间隙到达的行已被内核回显：擦掉残影再入队
      queue.push(v);
    }
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!('');
  });
  return {
    ask: (q) => {
      output.write(q);
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve('');
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

/** TTY 探测（测试经参数/tty 注入，不直接依赖此函数）。 */
export function isTty(): boolean {
  return process.stdout.isTTY === true;
}
