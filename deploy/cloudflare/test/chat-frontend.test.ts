// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chat 前端产物装配行为测试（#219 内容 4；#284 产物入包）：
 * - 命令形状：pnpm --filter … exec vite build --base=./ --emptyOutDir + VITE_CHAT_API=live；
 * - 产物搬运：modules/chat/assets/frontend → .deploy/cloudflare/modules/chat/assets/frontend（无条件重写：旧产物清空）；
 * - 升级路径：预置旧哈希 chunk 残留 → 装配后被清除（#162 同款纪律，不断言具体哈希）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChatFrontendAssets } from '../src/chat-frontend';

/** 记录型 run：抓 (cmd, args, cwd, env)；可回放真实前端 dist（预置夹具用）。 */
function fakeRun() {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const fn = async (cmd: string, args: string[], _cwd: string, opts?: { env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env ?? {} });
  };
  return { calls, fn };
}

/** 最小「构建产物」：assets/frontend/index.html + assets/index-<hash>.js（#284：vite outDir = 模块包内 assets/frontend）。 */
async function seedDist(root: string, hash: string): Promise<string> {
  const dist = join(root, 'modules/chat/assets/frontend');
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
