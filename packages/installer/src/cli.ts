// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 骨架（#53：主入口 = 本地 Web 向导；CLI 保留为逃生门/CI）。
 * 命令：init / list / use / current / destroy / wizard（默认）/ deploy（CI 直达九步）。
 * 纯注入设计：run(opts) 不直接依赖 process.*——argv/env/homedir/log 全部可注入（测试零进程副作用）。
 * 路径可见性（#53）：每次输出都以 pathline 开头，操作结束再重复一次（echoPathline）。
 */
import { rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createInstanceDir,
  echoPathline,
  instanceLayout,
  loadInstance,
  loadRegistry,
  pathline,
  refreshRegistry,
  registerInstance,
  registryPath,
  removeInstance,
  resolveCurrent,
  saveRegistry,
  type InstancesRegistry,
} from './index';

export interface RunOptions {
  argv: string[];
  env: { UNSELF_INSTANCE?: string; CLOUDFLARE_API_TOKEN?: string };
  home: string;
  cwd: string;
  log: (line: string) => void;
  err: (line: string) => void;
  /** 显式退出；缺省调用方在 run 返回后自行决定（测试不断言 process）。 */
  exit?: (code: number) => void;
  /** 部署/向导惰性加载（隔离 node 侧副作用，测试注入替身）。 */
  startWizard?: (opts: { instancePath: string; hasEnvToken: boolean; port?: number }) => Promise<number>;
  deployNineSteps?: (input: { instancePath: string }) => Promise<{ baseUrl: string; setupToken: string | null }>;
}

const USAGE: string[] = [
  'unself —— 零克隆安装器（主入口 = 本地 Web 向导；CLI 为逃生门/CI）',
  '',
  '用法：unself <命令>',
  '',
  '命令：',
  "  wizard [名字]        启动本地 Web 向导（默认命令；浏览器打开 http://localhost:<port>）",
  '  init [名字] [目录]   创建实例目录 <目录>/unself（缺省目录 = ./<名字>，缺省名字 = unself）',
  '  list [--json]        列出全部实例（名字 + 实例目录；--json 供编排）',
  '  use <名字>           切换当前实例（写注册表 current）',
  '  current              显示当前实例（名字 + 实例目录）',
  '  destroy <名字>       注销实例（--purge 连目录一起删；数据不可恢复，谨慎）',
  '  deploy               CI/逃生门：对当前实例直达九步装配（等价向导④）',
  '  help                 显示本帮助',
  '',
  '实例注册表：~/.unself/instances.json（只记「名字 → 路径」，不含秘密；可重建）',
  '环境变量：UNSELF_INSTANCE=<名字|路径> 临时覆盖当前实例',
];

/** 解析 argv → 命令与位置参数（--json/--purge 开关）。 */
export function parseArgs(argv: string[]): { cmd: string; args: string[]; json: boolean; purge: boolean } {
  const rest = argv.filter((a) => a !== '--json' && a !== '--purge');
  const cmd = rest[0] ?? 'wizard';
  return { cmd, args: rest.slice(1), json: argv.includes('--json'), purge: argv.includes('--purge') };
}

/** 取「当前实例」并做磁盘有效性校验（resolveCurrent 纯函数 + loadInstance 校验）。 */
export function resolveCurrentInstance(
  reg: InstancesRegistry,
  env: { UNSELF_INSTANCE?: string },
  cwd: string,
): { name: string; path: string } {
  const resolved = resolveCurrent(reg, env, cwd);
  if (!resolved) {
    throw new Error(
      '没有当前实例：先 `unself init <名字> <目录>` 创建，或 `unself use <名字>` 切换（已注册：'
        + (Object.keys(reg.instances).join('、') || '无') + '）',
    );
  }
  // 注册表存的是实例目录（…/unself）；loadInstance 约定收用户选定目录（其父目录）。
  loadInstance(dirname(resolved.path));
  return { name: resolved.name, path: resolved.path };
}

/** 已知命令表（未知命令先拦，不落到需要当前实例的分支给误导性错误）。 */
const KNOWN_COMMANDS = ['wizard', 'init', 'list', 'use', 'current', 'destroy', 'deploy', 'help', '--help', '-h'];

/** 执行单条命令（不吞异常：由 run 统一转人话 + exit 1）。 */
async function exec(opts: RunOptions): Promise<number> {
  const { argv, env, home, cwd, log } = opts;
  const { cmd, args, json, purge } = parseArgs(argv);

  // 未知命令先拦：不消耗注册表读取，也不给「没有当前实例」的误导性错误。
  if (!KNOWN_COMMANDS.includes(cmd)) {
    throw new Error(`未知命令「${cmd}」。可用命令见 unself help`);
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    for (const line of USAGE) log(line);
    return 0;
  }

  // ---- list（不需要当前实例）----
  if (cmd === 'list') {
    let reg = loadRegistry(home);
    const names = Object.keys(reg.instances);
    reg = refreshRegistry(reg, (p) => existsSync(p));
    if (reg !== undefined) saveRegistry(reg, home); // refresh 后回写（剔除已消失路径）
    if (json) {
      log(JSON.stringify({ registry: registryPath(home), current: reg.current, instances: reg.instances }, null, 2));
      return 0;
    }
    log(`实例注册表：${registryPath(home)}`);
    if (names.length === 0) {
      log('（空）—— 用 `unself init <名字> <目录>` 创建第一个实例');
      return 0;
    }
    for (const [name, p] of Object.entries(reg.instances)) {
      log(`${reg.current === name ? '* ' : '  '}${name}\t${pathline(p)}`);
    }
    return 0;
  }

  // ---- init ----
  if (cmd === 'init') {
    const name = args[0] ?? 'unself';
    const dir = args[1] !== undefined && args[1] !== '' ? resolve(args[1]) : join(cwd, name);
    const { layout } = createInstanceDir(dir);
    let reg = loadRegistry(home);
    reg = registerInstance(reg, name, layout.instanceDir);
    reg = { ...reg, current: name };
    saveRegistry(reg, home);
    log(`实例已创建并设为当前：${name}`);
    echoPathline(layout.instanceDir, log);
    log('下一步：`unself wizard` 打开本地向导（或 `unself deploy` CI 直达）。');
    return 0;
  }

  // ---- use ----
  if (cmd === 'use') {
    const name = args[0] ?? '';
    let reg = loadRegistry(home);
    if (!reg.instances[name]) {
      throw new Error(`实例「${name}」未注册（已注册：${Object.keys(reg.instances).join('、') || '无'}）`);
    }
    if (!existsSync(reg.instances[name] as string)) {
      throw new Error(`实例「${name}」的目录已消失：${reg.instances[name]}（用 \`unself list\` 查看现状）`);
    }
    reg = { ...reg, current: name };
    saveRegistry(reg, home);
    log(`当前实例已切换：${name}`);
    echoPathline(reg.instances[name] as string, log);
    return 0;
  }

  // ---- current ----
  if (cmd === 'current') {
    const reg = loadRegistry(home);
    const inst = resolveCurrentInstance(reg, env, cwd);
    log(`当前实例：${inst.name}`);
    echoPathline(inst.path, log);
    return 0;
  }

  // ---- destroy ----
  if (cmd === 'destroy') {
    const name = args[0] ?? '';
    const reg = loadRegistry(home);
    if (!reg.instances[name]) {
      throw new Error(`实例「${name}」未注册（已注册：${Object.keys(reg.instances).join('、') || '无'}）`);
    }
    const { reg: next, toPurge } = removeInstance(reg, name, { purgeDir: purge });
    saveRegistry(next, home);
    if (purge && toPurge) {
      rmSync(toPurge, { recursive: true, force: true });
      log(`已注销并删除实例目录：${name}`);
    } else {
      log(`已注销实例：${name}（目录保留；删除数据用 --purge）`);
    }
    if (toPurge) log(`原实例目录：${toPurge}`);
    return 0;
  }

  // ---- wizard（默认）/ deploy：都需要当前实例 ----
  const reg = loadRegistry(home);
  const inst = resolveCurrentInstance(reg, env, cwd);

  if (cmd === 'wizard') {
    const port = args.find((a) => /^--port=\d+$/.test(a));
    const start = opts.startWizard ?? (async (o) => {
      const { startWizardServer } = await import('./web/server');
      const stateMod = await import('./web/state');
      let state = stateMod.initialWizardState(o.instancePath);
      const { server, port: actual } = await startWizardServer({
        port: o.port,
        deps: {
          getState: () => state,
          setState: (s) => {
            state = s;
          },
          hasEnvToken: o.hasEnvToken,
          deploy: async (input) => {
            const fn = (await import('./deploy')).runDeploy;
            return fn({ instancePath: o.instancePath, domain: input.domain, modules: input.modules, onEvent: input.onEvent });
          },
        },
      });
      log(`向导已启动：http://localhost:${actual}`);
      log('浏览器打开上面的地址开始装配（Ctrl+C 退出）。');
      echoPathline(o.instancePath, log);
      // 常驻：向导进程随服务存活（CLI 调用方负责信号处理）。
      await new Promise<never>(() => {
        server.on('close', () => {
          // no-op：进程由外层结束
        });
      });
    });
    await start({ instancePath: inst.path, hasEnvToken: Boolean(env.CLOUDFLARE_API_TOKEN), port: port ? Number(port.slice('--port='.length)) : undefined });
    return 0;
  }

  if (cmd === 'deploy') {
    const fn = opts.deployNineSteps ?? (async (input) => (await import('./deploy')).runDeploy(input));
    const result = await fn({ instancePath: inst.path });
    log(`装配完成：${result.baseUrl}`);
    log(result.setupToken ? `setup 深链：/setup?token=${result.setupToken}` : '已有管理员：setup 已封箱。');
    echoPathline(inst.path, log);
    return 0;
  }

  throw new Error(`未知命令「${cmd}」。可用命令见 unself help`);
}

/** CLI 主入口：异常转人话 + exit 1（不裸栈）。 */
export async function run(opts: RunOptions): Promise<void> {
  try {
    const code = await exec(opts);
    opts.exit?.(code === 0 ? 0 : code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.err(`错误：${msg}`);
    opts.err('（多数失败可直接重跑：装配幂等收敛，不会重复创建资源）');
    opts.exit?.(1);
  }
}

/** instanceLayout 再导出（CLI 内部使用方便；index 已导出）。 */
export { instanceLayout };
