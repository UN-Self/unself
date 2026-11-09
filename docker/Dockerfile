# SPDX-License-Identifier: AGPL-3.0-only
# R2：单容器最简部署（核心 workbench）+ 首启自举（迁移 → mint 一次性 setup token → 打印深链接）。
#
# 运行体 = wrangler dev（进程模式，挂 workerd）+ workbench 产物（dist/worker.js + 壳 SPA dist/web）
# + 迁移 SQL（migrations/core/）。为什么 wrangler dev 而非裸 workerd：core bundle 以 workerd 为目标
# （import 'cloudflare:sockets' 在裸 Node 下直接 SyntaxError），而 wrangler dev 提供 D1（内置 SQLite）、
# --persist-to 状态外置（compose 卷挂这一层）、--var 注入 JWT_PRIVATE_KEY（免 .dev.vars 与 secret 样板）。
# wrangler 是 Apache-2.0 的 CLI，非 AGPL 交付物。
#
# ⚠️ wrangler dev 自声明不适合生产（无 supervisor/自动重启）；R2 验收 = 链接打印 + 可点进向导，暂可接受。
# TODO(#108): R1（native workerd + node:sqlite 全自管运行时）落地后本目录整块删除。
FROM node:22-slim
ARG WRANGLER_VERSION=4.129.0
ARG PNPM_VERSION=11.24.0
ENV NODE_ENV=production
WORKDIR /app

# 构建上下文：wb = app/workbench（docker build --build-context wb=<路径>，compose 里已配 additional_contexts）。
# dist/ = worker.js + 壳 SPA web/ + build-info.json；LICENSE/NOTICE（在 dist 内，build-worker.ts 随包拷入）上提到 /app。
COPY --from=wb dist/ /app/dist/
COPY --from=wb dist/LICENSE dist/NOTICE /app/
COPY --from=wb migrations/ /app/migrations/

# 运行时依赖仅 wrangler（workerd 由其依赖树带出）。pnpm 走 allowBuilds 白名单放行
# workerd/esbuild 的 install 脚本（platform 包正确解压，与仓库根 pnpm-workspace.yaml 同口径）。
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh \
 && corepack enable pnpm \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && printf '{"name":"unself-workbench-runtime","private":true}\n' > /app/package.json \
 && printf 'allowBuilds:\n  esbuild: true\n  workerd: true\n' > /app/pnpm-workspace.yaml \
 && CI=true pnpm add "wrangler@${WRANGLER_VERSION}" \
 && ln -s /app/node_modules/.bin/wrangler /usr/local/bin/wrangler \
 && wrangler --version

ENV UNSELF_PORT=8787 \
    UNSELF_DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8787

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
