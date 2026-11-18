# SPDX-License-Identifier: AGPL-3.0-only
# Calendar 本地容器：镜像只装已打包 npm 模块并运行同一个 Node 入口。
FROM node:22-alpine
WORKDIR /app
COPY unself-calendar-*.tgz ./module.tgz
RUN npm install -g ./module.tgz && rm module.tgz
EXPOSE 8791
CMD ["unself-calendar"]
