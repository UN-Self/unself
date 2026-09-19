// SPDX-License-Identifier: AGPL-3.0-only
/** tag → 发布目标（与 tag-to-package.mjs 一一对应；供 TS 侧引用拿到类型）。 */

export interface ReleaseTarget {
  /** npm 包名，如 `@unself/sdk` */
  package: string;
  /** workspace = 直接发 workspace 包目录；module = 先打包再发 tarball */
  kind: 'workspace' | 'module';
  /** 构建后可用的目录（workspace 包目录，或构建产物里的模块目录） */
  dir: string;
  /** 模块 id（kind=module 时存在） */
  id?: string;
}

export interface ReleaseTagResult extends ReleaseTarget {
  /** tag 里的包短名，如 `installer` */
  name: string;
  /** 版本号（tag 即版本） */
  version: string;
}

export declare const RELEASE_TARGETS: Record<string, ReleaseTarget>;
export declare function parseReleaseTag(tag: string): ReleaseTagResult;
export declare function toGithubOutput(result: ReleaseTagResult): string;
