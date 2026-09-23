// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 前端产物装配行为测试（#219 内容 4；#284 产物入包）：
 * - 命令形状：pnpm --filter … exec vite build --base=./ --emptyOutDir + VITE_CHAT_API=live；
 * - 产物搬运：app/modules/chat/assets/frontend → .deploy/cloudflare/modules/chat/assets/frontend（无条件重写：旧产物清空）；
 * - 升级路径：预置旧哈希 chunk 残留 → 装配后被清除（#162 同款纪律，不断言具体哈希）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChatFrontendAssets } from '../../src/engine/chat-frontend';

/** 记录型 run：抓 (cmd, args, cwd, env)；可回放真实前端 dist（预置夹具用）。 */
function fakeRun() {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const fn = async (cmd: string, args: string[], _cwd: string, opts?: { env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env ?? {} });
  };
  return { calls, fn };
}

/** 最小「构建产物」（默认分支，rootDir=仓库根形态）：<root>/app/modules/chat/assets/frontend。 */
async function seedDist(root: string, hash: string): Promise<string> {
  const dist = join(root, 'app/modules/chat/assets/frontend');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), `<script src="./assets/index-${hash}.js"></script>`);
  await writeFile(join(dist, `assets/index-${hash}.js`), `// ${hash}`);
  return dist;
}

describe('buildChatFrontendAssets（#219）', () => {
  it('命令形状 + 无产物人话报错：pnpm --filter … exec vite build --base=./ + VITE_CHAT_API=live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatfe-'));
    const outDir = join(root, '.deploy/cloudflare');
    const { calls, fn } = fakeRun();
    // 构建未产出 dist → 人话报错（不静默搬空目录）
    await expect(buildChatFrontendAssets({ rootDir: root, outDir, log: () => {}, run: fn })).rejects.toThrow(/产物缺失/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('pnpm');
    expect(calls[0]!.args.slice(0, 2)).toEqual(['--filter', '@unself/module-chat-frontend']);
    expect(calls[0]!.args.slice(2)).toEqual(['exec', 'vite', 'build', '--base=./', '--emptyOutDir']);
    expect(calls[0]!.env.VITE_CHAT_API).toBe('live');
    await rm(root, { recursive: true, force: true });
  });

  it('vite 构建的 cwd：buildCwd 优先，缺省回 rootDir（实例目录不在 pnpm workspace 内必炸——2026-09-22 走查实锤）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatfe-'));
    const outDir = join(root, '.deploy/cloudflare');
    const cwds: Array<string | undefined> = [];
    const run = async (_cmd: string, _args: string[], cwd: string) => {
      cwds.push(cwd);
      throw new Error('STOP');
    };
    await expect(
      buildChatFrontendAssets({ rootDir: root, outDir, log: () => {}, run }),
    ).rejects.toThrow('STOP');
    await expect(
      buildChatFrontendAssets({
        rootDir: root,
        outDir,
        log: () => {},
        run,
        buildCwd: '/repo/app/modules/chat',
      }),
    ).rejects.toThrow('STOP');
    expect(cwds).toEqual([root, '/repo/app/modules/chat']);
    await rm(root, { recursive: true, force: true });
  });

  it('产物搬运：dist → outDir/modules/chat/assets/frontend（含 index.html 与资产）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatfe-'));
    await seedDist(root, 'AAAA');
    const outDir = join(root, '.deploy/cloudflare');
    const { calls, fn } = fakeRun();
    const assetsDir = await buildChatFrontendAssets({ rootDir: root, outDir, log: () => {}, run: fn });
    expect(assetsDir).toBe('chat/assets/frontend');
    const dest = join(outDir, 'modules', assetsDir);
    const html = await (await import('node:fs/promises')).readFile(join(dest, 'index.html'), 'utf8');
    expect(html).toContain('index-AAAA.js');
    expect(await (await import('node:fs/promises')).readFile(join(dest, 'assets/index-AAAA.js'), 'utf8')).toBe('// AAAA');
    expect(calls).toHaveLength(1); // 注入的 run 未被绕过
    await rm(root, { recursive: true, force: true });
  });

  it('产物恒在 <chat 包根>/assets/frontend：buildCwd 明示时按 buildCwd 取（mod.dir 形态），缺省时按 rootDir 仓库布局取——两分支都不会「报成功但无产物」（codex-walk 2026-09-22 实锤）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatfe-'));
    const outDir = join(root, '.deploy/cloudflare');
    const buildCwd = await mkdtemp(join(tmpdir(), 'chatfe-src-'));
    // 产物落 <buildCwd>/assets/frontend（vite 在前端包目录跑，outDir 相对 vite root 解析）
    const dist = join(buildCwd, 'assets/frontend');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'index.html'), '<script src="./assets/index-DDDD.js"></script>');
    await writeFile(join(dist, 'assets/index-DDDD.js'), '// DDDD');
    const { calls, fn } = fakeRun();
    const assetsDir = await buildChatFrontendAssets({
      rootDir: root,
      outDir,
      log: () => {},
      run: fn,
      buildCwd,
    });
    expect(assetsDir).toBe('chat/assets/frontend');
    const html = await (await import('node:fs/promises')).readFile(join(outDir, 'modules/chat/assets/frontend/index.html'), 'utf8');
    expect(html).toContain('index-DDDD.js');
    expect(calls).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
    await rm(buildCwd, { recursive: true, force: true });
  });

  it('升级路径：旧哈希残留 → 装配后清除（无条件重写，#162 同款纪律）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatfe-'));
    const outDir = join(root, '.deploy/cloudflare');
    // 预置上一版产物（旧哈希 BBBB 在场）
    const dest = join(outDir, 'modules/chat/assets/frontend');
    await mkdir(join(dest, 'assets'), { recursive: true });
    await writeFile(join(dest, 'index.html'), '<script src="./assets/index-BBBB.js"></script>');
    await writeFile(join(dest, 'assets/index-BBBB.js'), '// BBBB');
    // 本次构建产出新哈希 CCCC
    await seedDist(root, 'CCCC');
    await buildChatFrontendAssets({ rootDir: root, outDir, log: () => {}, run: fakeRun().fn });
    const after = await (await import('node:fs/promises')).readFile(join(dest, 'index.html'), 'utf8');
    expect(after).toContain('index-CCCC.js');
    expect(after).not.toContain('index-BBBB.js');
    await expect((async () => {
      try { await (await import('node:fs/promises')).readFile(join(dest, 'assets/index-BBBB.js'), 'utf8'); return 'exists'; } catch { return 'gone'; }
    })()).resolves.toBe('gone');
    await rm(root, { recursive: true, force: true });
  });
});
