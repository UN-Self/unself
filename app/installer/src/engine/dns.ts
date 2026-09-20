// SPDX-License-Identifier: AGPL-3.0-only
/**
 * connect（external）模块的反代片段生成（决策 #63，issue #247）：
 *
 * 自托管模块页必须「恒挂根路径」（§9 不变式）：宿主负责把公网路径剥到模块的根——
 * 「前缀剥离归宿主」。本文件生成可直接粘贴的 Caddy / nginx 片段，**不代管**用户的
 * 反代（不写入、不重载、不校验远端配置——只给文本，部署者自己贴）。
 *
 * 片段语义（两种服务器同构）：
 * - 公网 https://<publicHost>/ → 反代到模块本机地址 <upstream>（默认 http://127.0.0.1:<port>/），
 *   路径原样透传（模块挂根，无前缀重写）；
 * - 透传 Host / X-Forwarded-* 头（模块页可能自建绝对 URL）；
 * - WebSocket 升级头（模块页可能开实时通道）；
 * - `frame-ancestors <壳 origin>` 提示注释：CSP 归模块页自身（#73：模块页因其自身
 *   CSP 归模块作者，本轮改为强制要求）——片段无法替模块页加头时，注释里给一行
 *   Caddy/nginx 的加头写法供作者/部署者按需启用。
 */

/** 反代片段输入（与 connect 模块注册面字段一一对应）。 */
export interface ReverseProxySnippetInput {
  /** 模块公网地址（https://todo.example.com）——用户填的 publicUrl。 */
  publicUrl: string;
  /** 模块本机上游（http://127.0.0.1:8080 或 http://localhost:3000/）。 */
  upstream: string;
  /** 壳（实例）origin：模块页 frame-ancestors 注释与 SDK coreOrigin 提示用。 */
  shellOrigin: string;
  /** 模块 id（注释标识用）。 */
  moduleId: string;
}

/** 解析 publicUrl → host:port（server_name / Host 匹配用）；非法 https URL → null。 */
export function publicHostOf(publicUrl: string): string | null {
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:') return null;
    return url.host; // 含非默认端口（如 example.com:8443）
  } catch {
    return null;
  }
}

/** Caddy 站点块（Caddyfile 片段）：路径原样透传（模块恒挂根路径，无 rewrite）。 */
export function caddySnippet(input: ReverseProxySnippetInput): string {
  const host = publicHostOf(input.publicUrl);
  if (host === null) {
    return `# [unself] publicUrl=${input.publicUrl} 不是合法 https://host 形态，未生成 Caddy 片段`;
  }
  return `# [unself] 模块 ${input.moduleId} 反代片段（决策 #63：前缀剥离归宿主，模块恒挂根路径）
# 用法：粘贴进 Caddyfile（或 /etc/caddy/Caddyfile 的导入文件），reload 生效。
# 注意：模块页自身 CSP 需带 frame-ancestors（#73）；若模块未带，在此站点内补一行为其加头：
#   header Content-Security-Policy "frame-ancestors ${input.shellOrigin}"
${host} {
\treverse_proxy ${input.upstream} {
\t\theader_up Host {host}
\t\theader_up X-Real-IP {remote_host}
\t\theader_up X-Forwarded-Proto {scheme}
\t}
}`;
}

/** nginx server 块（sites-available 片段）：路径原样透传（无重写）。 */
export function nginxSnippet(input: ReverseProxySnippetInput): string {
  const host = publicHostOf(input.publicUrl);
  if (host === null) {
    return `# [unself] publicUrl=${input.publicUrl} 不是合法 https://host 形态，未生成 nginx 片段`;
  }
  return `# [unself] 模块 ${input.moduleId} 反代片段（决策 #63：前缀剥离归宿主，模块恒挂根路径）
# 用法：粘贴进 /etc/nginx/sites-available/<site> 并软链到 sites-enabled，nginx -t && reload。
# 注意：模块页自身 CSP 需带 frame-ancestors（#73）；若模块未带，在此 server 内补一行为其加头：
#   add_header Content-Security-Policy "frame-ancestors ${input.shellOrigin}" always;
server {
\tlisten 443 ssl;
\tlisten [::]:443 ssl;
\tserver_name ${host};

\tlocation / {
\t\tproxy_pass ${input.upstream};
\t\tproxy_http_version 1.1;
\t\tproxy_set_header Host $host;
\t\tproxy_set_header X-Real-IP $remote_addr;
\t\tproxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
\t\tproxy_set_header X-Forwarded-Proto $scheme;
\t\tproxy_set_header Upgrade $http_upgrade;
\t\tproxy_set_header Connection "upgrade";
\t}
}`;
}

/** 两种片段一次拿（安装器/文档展示用）。 */
export function reverseProxySnippets(input: ReverseProxySnippetInput): { caddy: string; nginx: string } {
  return { caddy: caddySnippet(input), nginx: nginxSnippet(input) };
}
