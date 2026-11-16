# SPDX-License-Identifier: AGPL-3.0-only

# 测试

测行为，不测实现。不会红的测试删掉。

不是用户主动要求设计测试，就不要写测试，也不要补测试文件。

## 两问

1. 故意把业务行为改坏，它会红吗？不会红就是装饰。
2. 实现换了、行为没变，测试还要改吗？要跟着改就是在测实现，是负资产。

## 怎么写

- 后端以路由级集成为主（`app.fetch` / `app.request`）。纯函数单测只留给签名、解析、校验。
- 外部边界用真东西或假东西，业务代码内部不打桩。D1 用真 SQLite 加载真 migrations（`app/workbench/test/test-factory.ts`，`node:sqlite`）。IdP、时间、随机用 fake。
- 前端断言用户看得到的结果：点了之后路由变了、请求发出去了、状态切了。不断言 DOM 结构、类名、静态文案在不在。
- 边界要测：并发、先查后写、空态、失败态。修一个 bug，配一正一负。
- 迁移必须测「老库已经记过旧文件 + 再跑新迁移」。只把全部迁移在空库重放一遍，盖不住「旧文件改了也不重跑」。

## 不要写

- 断言文件在不在、源码里有没有某段字符串、内部调用了几次
- 断言永远不变的静态文案或快照。操作之后用户看得到的成功或失败提示可以断言
- 测试断言自己的 fixture
- 没有 schema 的假 D1。SQL 写错了还会绿

测试不依赖目录名和包名。定位仓库向上找 `pnpm-workspace.yaml`。改名、搬目录之后，行为断言不用改。

## 门禁

PR 前跟 `.github/workflows/ci.yml` 同一套：

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

`@unself/sdk` 的入口指向 `dist/`。不先 build，干净树上 typecheck 和 test 会找不到这个包。本地留着旧 `dist/` 而变绿，不算过。

发版由 tag 触发 `release.yml`，不在 PR 里重跑 CI。

## 验收

改了部署或页面，要用浏览器打开看一次。`/api/health` 返回 200 不算页面能用。截图和响应头留在对应的 issue 或 PR 里，不写进 `docs/`。
