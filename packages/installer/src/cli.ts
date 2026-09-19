// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI 骨架（#53：主入口 = 本地 Web 向导；CLI 保留为逃生门/CI）。
 * 命令：init / list / use / current / destroy / wizard（默认）/ deploy（CI 直达九步）。
 * 纯注入设计：run(opts) 不直接依赖 process.*——argv/env/homedir/log 全部可注入（测试零进程副作用）。
 * 路径可见性（#53）：每次输出都以 pathline 开头，操作结束再重复一次（echoPathline）。
 */
import { rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// 只依赖实例管理三库（零引擎依赖）：装配引擎仅在 deploy 分支动态加载——
// 独立安装制品（npx tarball）里核心命令不 import 引擎即可工作。
import { createInstanceDir, instanceLayout, loadInstance } from './lib/dir';
import {
  loadRegistry,
  refreshRegistry,
  registerInstance,
  registryPath,
  removeInstance,
  resolveCurrent,
  saveRegistry,
  type InstancesRegistry,
} from './lib/registry';
import { echoPathline, pathline } from './lib/pathline';

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
  startWizard?: (opts: {
    instancePath: string;
    hasEnvToken: boolean;
    port?: number;
    /** 模块存储声明投影（#55）：CLI 从模块包 manifest 读出后传入（③½ 渲染与校验依据）。 */
    storageOptions?: Array<{ id: string; accepts: string[]; preferred?: string }>;
    /** 本实例资源名预览（#272）：向导页展示「会占用哪些 CF 资源名」。 */
    resourceNames?: Array<{ kind: string; name: string }>;
  }) => Promise<number>;
  deployNineSteps?: (input: {
    instancePath: string;
    /** 撞车守卫放行开关（#272）。 */
    allowAdopt?: boolean;
    /** 来源漂移已确认（#269，`--yes`）。 */
    yes?: boolean;
    /** 九步进度事件转发（#272：`unself deploy` 不再吞进度）。 */
    onEvent?: (text: string) => void;
  }) => Promise<{ baseUrl: string; setupToken: string | null }>;
  /**
   * `module remove` 卸载执行桥（缺省 = 动态加载 `./deploy.removeModuleFromInstance`，
   * 测试注入替身以免真连 CF）。形状同引擎 RemoveModuleResult + configRemoved。
   */
  moduleRemove?: (input: { instancePath: string; moduleId: string; log?: (line: string) => void }) => Promise<{
    moduleId: string;
    level: string;
    tablesDropped: string[];
    ledgerTable: string | null;
    routeRemoved: boolean;
    workerDeleted: boolean;
    removedFromRegistry: boolean;
    lockUpdated: boolean;
    configRemoved: boolean;
  }>;
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
  '  module pack [目录]   把模块目录打成 .tgz（--out <目录>；可直接 npm publish，与官方模块同一套包形态）',
  '                    --version <x.y.z> 覆盖版本（同时写进 manifest.json 与生成的 package.json；tag 即版本）',
  '                    --name <@scope/pkg> 覆盖生成的 package.json 的 npm 包名（缺省 = manifest.id）',
  '  module add <来源>    解析来源（npm:/github:/https:/file:）→ 写 config+lock 并预暂存',
  '                    --as <名字> 覆盖实例内 id；解析会做未知能力门禁（点名声拒）',
  '  module validate [目录]  对模块目录跑 §7 六类发布前硬检查（缺 manifest 即人话错）',
  '  module remove <id>    卸载模块：撤路由 → 删 Worker → 按 tables 清单删表 → 清记账 → 注册表移除',
  '                    （成功后同步从 unself.config.jsonc 的 modules 段移除；不在 config 里则拒不动作）',
  '  deploy [--allow-adopt] [--yes]  CI/逃生门：对当前实例直达九步装配（等价向导④）',
  '                    --allow-adopt = 撞车守卫放行（台账证明不了归属时显式接管同名资源）',
  '                    --yes = 来源漂移已确认（新装/换源时不列 diff 直接解析）',
  '  help                 显示本帮助',
  '',
  '实例注册表：~/.unself/instances.json（只记「名字 → 路径」，不含秘密；可重建）',
  '环境变量：UNSELF_INSTANCE=<名字|路径> 临时覆盖当前实例',
];

/** 解析 argv → 命令与位置参数（--json/--purge/--allow-adopt 开关）。 */
export function parseArgs(argv: string[]): {
  cmd: string;
  args: string[];
  json: boolean;
  purge: boolean;
  allowAdopt: boolean;
  yes: boolean;
} {
  const allowAdopt = argv.includes('--allow-adopt') || argv.includes('--allow-shared-account');
  const yes = argv.includes('--yes') || argv.includes('-y');
  const rest = argv.filter(
    (a) =>
      a !== '--json' &&
      a !== '--purge' &&
      a !== '--allow-adopt' &&
      a !== '--allow-shared-account' &&
      a !== '--yes' &&
      a !== '-y',
  );
  const cmd = rest[0] ?? 'wizard';
  return { cmd, args: rest.slice(1), json: argv.includes('--json'), purge: argv.includes('--purge'), allowAdopt, yes };
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
const KNOWN_COMMANDS = ['wizard', 'init', 'list', 'use', 'current', 'destroy', 'module', 'deploy', 'help', '--help', '-h'];

/** 位置参数/取值开关解析（`--out <dir>` / `--as <id>` 消费后一个 token）。 */
function splitPositional(args: string[], valueFlags: string[]): { positionals: string[]; values: Record<string, string> } {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) {
      values[a] = args[i + 1] ?? '';
      i++;
      continue;
    }
    const eq = valueFlags.find((f) => a.startsWith(`${f}=`));
    if (eq) {
      values[eq] = a.slice(eq.length + 1);
      continue;
    }
    positionals.push(a);
  }
  return { positionals, values };
}

/** 执行单条命令（不吞异常：由 run 统一转人话 + exit 1）。 */
async function exec(opts: RunOptions): Promise<number> {
  const { argv, env, home, cwd, log, err } = opts;
  const { cmd, args, json, purge, allowAdopt, yes } = parseArgs(argv);

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
    // 资源名预览（#272）：让用户看到本实例会占用哪些 CF 资源名（不用手记环境变量）。
    try {
      const { previewInstanceResources } = await import('./deploy');
      const preview = await previewInstanceResources(layout.instanceDir);
      log(`资源命名空间：${preview.namespace ?? '（未设置 → 历史命名 unself-*）'}`);
      log('本实例将占用以下 Cloudflare 资源名（同账户隔离靠它们）：');
      for (const n of preview.names) log(`  ${n.kind}　${n.name}`);
    } catch (err) {
      log(`（资源名预览不可用：${err instanceof Error ? err.message : String(err)}）`);
    }
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

  // ---- module pack / module add（#269）----
  if (cmd === 'module') {
    const sub = args[0] ?? '';
    const { positionals, values } = splitPositional(args.slice(1), ['--out', '--as', '--version', '--name']);
    if (sub === 'pack') {
      const dir = positionals[0] ?? cwd;
      const outDir = values['--out'];
      const version = values['--version'];
      const npmName = values['--name'];
      const { packModule } = await import('./deploy');
      const r = await packModule({
        dir,
        ...(outDir !== undefined ? { outDir } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(npmName !== undefined ? { npmName } : {}),
        log,
      });
      log(`已打包模块：${r.id} v${r.version}`);
      log(`包文件：${r.files.length} 个（${r.files.join('、')}）`);
      log(`tarball：${r.tarballPath}`);
      log(`integrity：${r.integrity}`);
      return 0;
    }
    if (sub === 'add') {
      const source = positionals[0] ?? '';
      if (!source) throw new Error('用法：unself module add <来源> [--as <实例内名字>]（来源形如 npm:@acme/pkg@1.2.0）');
      const as = values['--as'];
      const reg = loadRegistry(home);
      const inst = resolveCurrentInstance(reg, env, cwd);
      const { addModuleSource } = await import('./deploy');
      const r = await addModuleSource({ instancePath: inst.path, source, ...(as !== undefined ? { as } : {}), log });
      log(`已添加模块：${r.id} v${r.version}（来源 ${r.source}）`);
      if (r.integrity) log(`SRI：${r.integrity}`);
      log(`声明权限：${r.permissions.length > 0 ? r.permissions.join('、') : '（无）'}`);
      log(`数据落点：accepts=${r.storage.accepts.join('/')}${r.storage.preferred ? `，preferred=${r.storage.preferred}` : ''}`);
      log(`已写入：${pathline(r.configPath)}（modules 段）与 ${pathline(r.lockPath)}`);
      log('下一步：`unself deploy`（lock 已命中，不会重复下载，也不会因来源漂移报错）。');
      echoPathline(inst.path, log);
      return 0;
    }
    // ---- module validate（#270）：库层检查在 @unself/contracts，这里只做命令与输出 ----
    if (sub === 'validate') {
      const dir = positionals[0] ?? cwd;
      const { validateModuleDir, formatValidateDiagnostic } = await import('./lib/module-validate');
      const r = await validateModuleDir(dir);
      const label = r.id !== undefined ? `${r.id}${r.version !== undefined ? ` v${r.version}` : ''}` : dir;
      for (const d of r.errors) log(formatValidateDiagnostic(d));
      for (const d of r.warnings) log(formatValidateDiagnostic(d));
      if (r.ok) {
        log(`✓ 模块校验通过：${label}（错误 0，警告 ${r.warnings.length}）`);
        return 0;
      }
      err(`✗ 模块校验未通过：${label}（错误 ${r.errors.length}，警告 ${r.warnings.length}）`);
      return 1;
    }
    // ---- module remove（#270）：引擎卸载 + 同步 config ----
    if (sub === 'remove') {
      const id = positionals[0] ?? '';
      if (!id) throw new Error('用法：unself module remove <实例内 id>（与 `unself module add` 对称；成功后同步改 config）');
      const reg = loadRegistry(home);
      const inst = resolveCurrentInstance(reg, env, cwd);
      const { removeModuleFromInstance } = await import('./deploy');
      const fn = opts.moduleRemove ?? ((i) => removeModuleFromInstance(i));
      const r = await fn({ instancePath: inst.path, moduleId: id, log });
      log(`已卸载模块：${r.moduleId}（落点 ${r.level}）`);
      log(
        r.tablesDropped.length > 0
          ? `已删表（按 tables 清单）：${r.tablesDropped.join('、')}`
          : '清单内无表可删（core/external 落点或未申报）',
      );
      if (r.ledgerTable) log(`已清记账表：${r.ledgerTable}`);
      log(`路由：${r.routeRemoved ? '已撤' : '未涉及'}；Worker：${r.workerDeleted ? '已删' : '本不存在'}；注册表：${r.removedFromRegistry ? '已移除' : '本无'}`);
      log(`已从 unself.config.jsonc 的 modules 段移除${r.lockUpdated ? '，unself.lock 已更新' : ''}。`);
      echoPathline(inst.path, log);
      return 0;
    }
    throw new Error(`未知 module 子命令「${sub}」。可用：unself module pack|add|validate|remove`);
  }

  // ---- wizard（默认）/ deploy：都需要当前实例 ----
  const reg = loadRegistry(home);
  const inst = resolveCurrentInstance(reg, env, cwd);

  if (cmd === 'wizard') {
    const port = args.find((a) => /^--port=\d+$/.test(a));
    const start = opts.startWizard ?? (async (o) => {
      const { startWizardServer } = await import('./web/server');
      const stateMod = await import('./web/state');
      let state = stateMod.initialWizardState(o.instancePath, {
        ...(o.storageOptions ? { storageOptions: o.storageOptions as never[] } : {}),
        ...(o.resourceNames ? { resourceNames: o.resourceNames } : {}),
      });
      const { server, port: actual } = await startWizardServer({
        port: o.port,
        deps: {
          getState: () => state,
          setState: (s) => {
            state = s;
          },
          hasEnvToken: o.hasEnvToken,
          ...(o.storageOptions ? { storageOptions: o.storageOptions as never[] } : {}),
          deploy: async (input) => {
            const fn = (await import('./deploy')).runDeploy;
            return fn({
              instancePath: o.instancePath,
              domain: input.domain,
              modules: input.modules,
              ...(input.storageChoices ? { storageChoices: input.storageChoices } : {}),
              ...(input.token ? { token: input.token } : {}),
              ...(input.allowAdopt ? { allowAdopt: true } : {}),
              ...(input.yes ? { yes: true } : {}),
              onEvent: input.onEvent,
            });
          },
          // #269 ③ 来源解析：探到就展示「将要装什么」；未知能力在此报名字拒绝。
          resolveModule: async (source) => {
            const { describeModuleSource } = await import('./deploy');
            const p = await describeModuleSource(source, { instancePath: o.instancePath, log });
            return {
              id: p.id,
              source: p.source,
              kind: p.kind,
              version: p.version,
              ...(p.integrity !== undefined ? { integrity: p.integrity } : {}),
              permissions: p.permissions,
              storageAccepts: p.storage.accepts as never[],
              ...(p.storage.preferred !== undefined ? { storagePreferred: p.storage.preferred as never } : {}),
              manifestHash: p.manifestHash,
            };
          },
          // #269 ① token 真验（CF GET /user/tokens/verify）：无效与网络/权限问题分开报。
          verifyToken: async (token) => {
            const { verifyApiToken } = await import('./deploy');
            const r = await verifyApiToken(token);
            return { ok: r.ok, message: r.message };
          },
          // #269 ③ 改模块后重算资源名预览（不再沿用启动时快照）。
          previewResources: async (moduleIds) =>
            (await (await import('./deploy')).previewInstanceResources(o.instancePath, moduleIds)).names,
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
    await start({
      instancePath: inst.path,
      hasEnvToken: Boolean(env.CLOUDFLARE_API_TOKEN),
      port: port ? Number(port.slice('--port='.length)) : undefined,
      // #55/#284：按 config 条目的来源做本地解析（npm 本地命中 / file: 目录）读模块 manifest
      // 的 storage 声明，供向导③½ 做四级单选与 accepts 校验（不联网、不下载）
      storageOptions: await (await import('./deploy')).wizardStorageOptions(inst.path),
      // #272：本实例会占用的 CF 资源名（ wizard 页预览）
      resourceNames: (await (await import('./deploy')).previewInstanceResources(inst.path)).names,
    });
    return 0;
  }

  if (cmd === 'deploy') {
    const fn = opts.deployNineSteps ?? (async (input) => (await import('./deploy')).runDeploy(input));
    // #272：转发九步事件；#269：`--yes` 把「来源漂移已确认」传给引擎。
    const result = await fn({ instancePath: inst.path, allowAdopt, yes, onEvent: (line) => log(line) });
    log(`装配完成：${result.baseUrl}`);
    log(result.setupToken ? `setup 深链：/setup?token=${result.setupToken}` : '已有管理员：setup 已封箱。');
    echoPathline(inst.path, log);
    return 0;
  }

  throw new Error(`未知命令「${cmd}」。可用命令见 unself help`);
}

/** CLI 主入口：异常转人话 + exit 1（不裸栈）。
 * 部署语义提示（「可直接重跑」）只对装配路径（deploy）显示——module add/remove/validate 等窄命令
 * 贴这句话会误导（装/卸模块不幂等收敛，错了要按报错修）。
 */
export async function run(opts: RunOptions): Promise<void> {
  try {
    const code = await exec(opts);
    opts.exit?.(code === 0 ? 0 : code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.err(`错误：${msg}`);
    if (parseArgs(opts.argv).cmd === 'deploy') {
      opts.err('（多数失败可直接重跑：装配幂等收敛，不会重复创建资源）');
    }
    opts.exit?.(1);
  }
}

/** instanceLayout 再导出（CLI 内部使用方便；index 已导出）。 */
export { instanceLayout };
