// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 失败三要素映射（PRODUCT_SPEC §5.5 ④：原因 / 归属 / 修复）。
 * 铁律：只映射已知失败（10405 / 10000 / DNS 未就绪 / 网络中断 / 缺 token），其余一律归
 * 「代码」并给幂等重跑——不枚举 CF 全部错误码（禁过度防御）。
 */

export interface FailureAdvice {
  /** 原始错误摘要（人话一行）。 */
  cause: string;
  /** 归属：token 权限 · DNS · 网络 · 代码。 */
  owner: 'token' | 'dns' | 'network' | 'code';
  /** 对应修复动作。 */
  fix: string;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 已知失败 → 三要素。未知失败不硬归类到外部原因，默认幂等重跑。 */
export function advise(err: unknown): FailureAdvice {
  const msg = messageOf(err);
  // WranglerError 把 stderr 细节附在第二行起：三要素的「原因」要携带原始错误摘要（含错误码），
  // 故取含已知特征（10405 等）的首个非空行，取不到时退回首行。
  const lines = msg.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  const cause = (lines.find((l) => /10405|10000|ENOTFOUND|无法获取|fetch failed|ECONNRESET|ETIMEDOUT|不可达|CLOUDFLARE_API_TOKEN/.test(l)) ?? lines[0] ?? msg).slice(0, 300);
  if (msg.includes('10405')) {
    return {
      cause,
      owner: 'token',
      fix: '你的 token 缺 Zone 级权限：用第一屏的深链接重建 token（勾选 Workers Routes / DNS / SSL and Certificates），然后重跑本命令',
    };
  }
  // #309 ④：wrangler OAuth scope 集合不含 DNS 记录读写（2026-09-21 实测 GET/POST 都 10000，
  // docs/audit/241-*），自有域 + OAuth 在 dns_records 上必挂——幂等重跑解决不了权限缺口。
  if (/\b10000\b/.test(msg)) {
    return {
      cause,
      owner: 'token',
      fix: '当前凭证（wrangler OAuth）无 DNS 记录权限：在 CF 控制台为该域名手动添加 A 记录 192.0.2.1（开启代理），或改用 API Token（含 Zone · DNS · Edit）重跑自动创建',
    };
  }
  if (msg.includes('ENOTFOUND') || msg.includes('无法获取 Core 公钥') || /DNS/i.test(msg)) {
    return {
      cause,
      owner: 'dns',
      fix: 'DNS 解析未生效：等 60 秒重跑本命令（幂等，只会补齐没完成的部分）',
    };
  }
  if (msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('不可达')) {
    return {
      cause,
      owner: 'network',
      fix: '网络中断或临时故障：检查网络（workers.dev 域名可能需要代理环境变量）后重跑本命令',
    };
  }
  if (msg.includes('CLOUDFLARE_API_TOKEN')) {
    return {
      cause,
      owner: 'token',
      fix: 'export CLOUDFLARE_API_TOKEN=<token> 后重跑；没有 token 就用第一屏的深链接创建',
    };
  }
  return {
    cause,
    owner: 'code',
    fix: '直接重跑同一条命令即可：装配器幂等收敛，不会重复创建资源',
  };
}

const OWNER_LABEL: Record<FailureAdvice['owner'], string> = {
  token: '你的 token 权限',
  dns: 'DNS（传播/记录）',
  network: '网络',
  code: '代码/配置',
};

/** 三要素输出行（「  原因：… / 归属：… / 修复：…」）。 */
export function formatAdvice(a: FailureAdvice): string[] {
  return [`  原因：${a.cause}`, `  归属：${OWNER_LABEL[a.owner]}`, `  修复：${a.fix}`];
}
