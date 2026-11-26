// SPDX-License-Identifier: AGPL-3.0-only
/** 构建期以文本方式引入 .sql（esbuild loader: { '.sql': 'text' }）。 */
declare module '*.sql' {
  const sql: string;
  export default sql;
}
