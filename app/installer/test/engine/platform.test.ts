// SPDX-License-Identifier: AGPL-3.0-only
/**
 * platform.ts 纯函数行为测试（#246 / 决策 #67）：
 * 全部经注入参数在 Linux 上覆盖 Windows/macOS/WSL 分支（CI 保持 Linux，不碰真实机器）。
 * 红灯点：把平台分支改坏（win32 掉 APPDATA / XDG 优先级颠倒 / 版本警告丢失）必红。
 */
import { describe, expect, it } from 'vitest';
import {
  VERIFIED_WRANGLER_VERSION,
  parseWranglerVersionOutput,
  wranglerConfigDirFor,
  wranglerVersionWarning,
} from '../../src/engine/platform';

describe('wranglerConfigDirFor（决策 #67：注入参数覆盖三平台分支）', () => {
  it('WRANGLER_CONFIG_DIR 显式指定：三平台一律直取（wrangler 官方约定）', () => {
    const base = { env: { WRANGLER_CONFIG_DIR: '/custom/wrangler' }, homedir: '/home/u' };
    expect(wranglerConfigDirFor({ ...base, platform: 'linux' })).toBe('/custom/wrangler');
    expect(wranglerConfigDirFor({ ...base, platform: 'win32' })).toBe('/custom/wrangler');
    expect(wranglerConfigDirFor({ ...base, platform: 'darwin' })).toBe('/custom/wrangler');
  });

  it('XDG_CONFIG_HOME 次优先（实测：XDG 指空目录 → whoami 变未登录，wrangler 读 $XDG/.wrangler）', () => {
    expect(
      wranglerConfigDirFor({ env: { XDG_CONFIG_HOME: '/tmp/empty-cfg' }, platform: 'linux', homedir: '/home/u' }),
    ).toBe('/tmp/empty-cfg/.wrangler');
    // XDG 在时平台分支不参与
    expect(
      wranglerConfigDirFor({ env: { XDG_CONFIG_HOME: '/tmp/empty-cfg', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\u' }),
    ).toBe('/tmp/empty-cfg/.wrangler');
  });

  it('win32 分支（Linux 上注入 platform+APPDATA 测绿）：APPDATA/.wrangler；缺 APPDATA → null（无力判定，不瞎猜）', () => {
    expect(
      wranglerConfigDirFor({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\u' }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming/.wrangler');
    expect(wranglerConfigDirFor({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' })).toBeNull();
  });

  it('darwin 分支（Linux 上注入 platform 测绿）：~/Library/Preferences/.wrangler', () => {
    expect(wranglerConfigDirFor({ env: {}, platform: 'darwin', homedir: '/Users/u' })).toBe('/Users/u/Library/Preferences/.wrangler');
  });

  it('linux 分支（含 WSL——WSL 就是 Linux 用户态）：~/.config/.wrangler', () => {
    expect(wranglerConfigDirFor({ env: {}, platform: 'linux', homedir: '/home/u' })).toBe('/home/u/.config/.wrangler');
    // 本机实测形状（wrangler 4.129.x 布局）与纯函数一致
    expect(wranglerConfigDirFor({ env: {}, platform: 'linux', homedir: '/home/huangyinghui' })).toBe(
      '/home/huangyinghui/.config/.wrangler',
    );
  });

  it('unknown 平台（理论不达）→ null 不瞎猜', () => {
    expect(wranglerConfigDirFor({ env: {}, platform: 'unknown', homedir: '/home/u' })).toBeNull();
  });
});

describe('parseWranglerVersionOutput + wranglerVersionWarning（版本 ≠ 4.129.0 → 警告）', () => {
  it('从装饰输出提取版本（实测 `wrangler --version` 输出形状）', () => {
    expect(parseWranglerVersionOutput('4.129.0')).toBe('4.129.0');
    expect(parseWranglerVersionOutput(' ⛅️ wrangler 4.129.1 (update available 4.134.0)\n─────────')).toBe('4.129.1');
  });

  it('解析不出 → null（发警告），不猜', () => {
    expect(parseWranglerVersionOutput('无版本信息')).toBeNull();
  });

  it('等于已验证版本 → 无警告；更高版本也警告（覆盖矩阵未验证）', () => {
    expect(wranglerVersionWarning('4.129.0')).toBeNull();
    expect(wranglerVersionWarning('4.134.0')).toContain('4.134.0');
    expect(wranglerVersionWarning('4.134.0')).toContain('4.129.0');
    expect(VERIFIED_WRANGLER_VERSION).toBe('4.129.0');
  });

  it('版本未知（null）→ 发警告（红灯点：吞掉未知状态必红）', () => {
    expect(wranglerVersionWarning(null)).toContain('未取到 wrangler 版本');
  });
});
