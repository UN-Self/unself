# @unself/installer

本地 Web 向导与 `unself` CLI，把工作台和选中的模块装配到你自己的 Cloudflare 账户。

## 使用

```sh
npx @unself/installer@latest
```

向导会打开浏览器，依次完成凭证、域名、模块、模块配置、数据存放、九步装配和完成页。装配日志默认折叠；完成页提供一次性激活入口和工作台登录入口。

升级已有实例时重新运行同一命令即可。安装器更新只更新后续部署使用的产物；要让线上 Worker 使用新版本，需要完成一次部署。凭证只在本次进程内存中使用，不写入项目配置。

需要排障时保留终端里的失败三要素和请求编号，并查看 [部署指南](https://github.com/UN-Self/unself/blob/main/docs/deploy.md)。

要求 Node.js 22 或更高版本。
