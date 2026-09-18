#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * deploy/cloudflare 入口：仓库根执行 `node deploy/cloudflare/bin.ts`（文档唯一启动方式）。
 *
 * src/ 是无后缀 ESM 导入的 TypeScript：tsx（本包既有依赖，零新增）直接跑得动；
 * 裸 node ≥22.6 原生剥类型但解析不了无后缀导入，此时进程内注册 tsx 加载器重试。
 * 不重开进程，TTY/管道/信号天然透传。
 *
 * --help/--version 短路（#249）：parseCliArgs 通过后先看 info 位——打印即退出（exit 0），
 * 不读配置、不问 token、不进九步，绝不触发部署。异常收尾统一 exit 1。
 */
import { register } from 'tsx/esm/api';
import { readFileSync } from 'node:fs';
import {
  buildTokenDeepLink,
  buildTokenFirstScreen,
  collectToken,
  parseCliArgs,
  TOKEN_PERMISSION_TABLE,
  UnknownFlagError,
  usageText,
} from './src/interactive.ts';

/** 包版本（--version 用；bin.ts 在包根，读自身 package.json）。 */
function pkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 装配主流程延迟到 info 短路之后（--help/--version 不得触发部署）。 */
async function boot(): Promise<typeof import('./src/main.ts')> {
  try {
    return await import('./src/main.ts');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    }
    register();
    return await import('./src/main.ts');
  }
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  let cli;
  try {
    cli = parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UnknownFlagError) {
      console.error(`错误：${(e as Error).message}`);
      console.error(usageText(pkgVersion()).join('\n'));
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  if (cli.info === 'help') {
    console.log(usageText(pkgVersion()).join('\n'));
    return;
  }
  if (cli.info === 'version') {
    console.log(pkgVersion());
    return;
  }
  // token 采集前置（#249 掩码 + 可重试 + 预校验；终端路径）：TTY 且无 env 时在入口完成，
  // 结果只写本次进程环境——main.ts 看到的就是已就绪的 CLOUDFLARE_API_TOKEN，其内部
  // 「TTY 明文粘贴」分支自然不再被走到（载体归 Web 向导，见决策 #70，main.ts 不在本 issue 文件面）。
  // 非 TTY 不拦截：main.ts 自己打印第一屏 + export 指引并优雅退出（CI 既定行为）。
  if (!process.env.CLOUDFLARE_API_TOKEN && process.stdout.isTTY === true) {
    for (const line of buildTokenFirstScreen({
      deepLink: buildTokenDeepLink(),
      permissionTable: TOKEN_PERMISSION_TABLE,
      tty: true,
    })) {
      console.log(line);
    }
    const token = await collectToken({ out: (l) => console.log(l) }, process.stdin.isTTY === true);
    if (!token) {
      console.error('未提供有效 token：退出。重跑本命令可随时再来（幂等）；也可 export CLOUDFLARE_API_TOKEN=<粘贴> 后重跑。');
      process.exitCode = 1;
      return;
    }
    process.env.CLOUDFLARE_API_TOKEN = token;
  }
  const { main } = await boot();
  await main(argv);
}

try {
  await run();
} catch (err: unknown) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
} finally {
  // token 交互（stty -echo + readline）结束后，stdin 不得把进程挂在可读暂停态；
  // 非 TTY/部分嵌入式流没有 unref（实测 node 26 管道下无此方法），探后再调
  if (typeof process.stdin.unref === 'function') process.stdin.unref();
}
