# SPDX-License-Identifier: AGPL-3.0-only
# docker 跑法（#111）：镜像 = npm 包的薄壳——装包、跑同一个 bin；配置全走 env。
# 构建上下文须含已 pack 的 tarball（pnpm pack --pack-destination .）。
FROM node:22-alpine
WORKDIR /app
COPY unself-hello-*.tgz ./module.tgz
RUN npm install -g ./module.tgz && rm module.tgz
EXPOSE 8790
CMD ["unself-hello"]
