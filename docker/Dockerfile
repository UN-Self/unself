# SPDX-License-Identifier: AGPL-3.0-only
# Unself workbench 正式运行体镜像（#360 轨道 A）：单阶段，镜像里只有装好的 npm 包 + Node 运行时。
#
# 为什么是「装包」不是「源码构建」：
#   - 跟裸机 `npx @unself/workbench start` 是同一个 bin、同一条命令（bin `workbench` → start），
#     不再另造一条只在 Docker 里存在的启动路径。
#   - 构建（pnpm / esbuild / vite / bundle）已经在 CI 发包时做完，镜像里不需要 pnpm、esbuild
#     或任何源码；镜像内容 = 发布产物，与 registry 上那个包完全一致。
#   - 升级 = 换 UNSELF_VERSION 重建（或换 dist-tag），不需要重新拉仓库源码。
#
# UNSELF_VERSION 是 npm dist-tag 或精确版本，不是 git ref：
#   latest（默认，正式部署）/ test（联调测试包，例如 --build-arg UNSELF_VERSION=test）/ 0.1.2
#
# 自定义环境变量（UNSELF_DB / UNSELF_FILES / UNSELF_BASE_URL / JWT_PRIVATE_KEY …）一律由
# compose 的 environment 注入，这里只固定容器内不变的 UNSELF_ADDR / UNSELF_DATA_DIR。
#
# 跑未发布的分支（源码构建）用 docker/Dockerfile.dev，见 docker/README.md。

FROM node:22-slim

# npm dist-tag 或精确版本号（split 自 release.yml 的分支规则：main tag → latest，其他 → test）。
ARG UNSELF_VERSION=latest

# 全局安装即得 /usr/local/bin/workbench；清缓存让镜像不背 npm 的下载残留。
RUN npm i -g @unself/workbench@${UNSELF_VERSION} && npm cache clean --force

# 容器内固定项。其余环境变量走 compose。
ENV NODE_ENV=production \
    UNSELF_ADDR=0.0.0.0:8787 \
    UNSELF_DATA_DIR=/app/data

# 非 root：node 镜像自带 uid/gid 1000 的 node 用户。只把数据目录交给它——具名卷首次挂载
# 会继承镜像内该目录的属主，所以默认 compose（具名卷）开箱即写；宿主目录 bind mount 时
# 必须宿主侧先 `chown 1000:1000`（见 docker/README.md）。
RUN mkdir -p /app/data && chown node:node /app/data

USER node

VOLUME /app/data
EXPOSE 8787

# slim 镜像没有 curl：用镜像自带的 node 打健康检查（/api/health 返回 200）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# exec 形式：workbench / node 直接是 PID 1，SIGTERM 直达，没有中间 shell 残留。
# 自举（迁移、签名私钥、首启 setup token）都在 start 里，跟裸机同一条命令。
ENTRYPOINT ["workbench", "start"]
