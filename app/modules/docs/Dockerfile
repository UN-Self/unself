# SPDX-License-Identifier: AGPL-3.0-only
# docker 跑法（#358）：镜像 = npm 包的薄壳——装包、跑同一个 bin；配置全走 env。
# 构建上下文须含已 pack 的 tarball（pnpm pack --pack-destination .）。
FROM node:22-alpine
WORKDIR /app
COPY unself-docs-*.tgz ./module.tgz
RUN npm install -g ./module.tgz && rm module.tgz
# 数据目录归 uid 1000（与平台镜像同一约定），具名卷开箱即写
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data
USER 1000
EXPOSE 8791
CMD ["unself-docs"]
