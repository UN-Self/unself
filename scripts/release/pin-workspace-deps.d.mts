// SPDX-License-Identifier: AGPL-3.0-only
/** 类型声明（与 pin-workspace-deps.mjs 一一对应；供 TS 侧引用拿到类型）。 */

export declare const WORKSPACE_SPEC_RE: RegExp;
export declare function rewriteWorkspaceSpec(spec: string, localVersion: string): string;
export interface PinResult<T = Record<string, unknown>> {
  pkg: T;
  changed: string[];
}
export declare function pinWorkspaceDeps<T extends Record<string, unknown>>(
  pkg: T,
  resolveVersion: (name: string) => string | undefined,
): PinResult<T>;
export declare function collectWorkspaceVersions(root: string): Promise<Map<string, { version: string; dir: string }>>;
export declare function pinPackageDir(pkgDir: string, root: string): Promise<string[]>;
