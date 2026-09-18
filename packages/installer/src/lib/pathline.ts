// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 路径可见性（#242）：CLI 与 Web 共用的唯一模板出处。
 * 任何展示实例路径的输出，都必须且恰好经由本文件渲染，防实现各自漂移。
 */

/** 渲染路径行：`实例目录：<instancePath>`。 */
export function pathline(instancePath: string): string {
  return `实例目录：${instancePath}`;
}

/**
 * 输出路径行：首行 + 操作结束重复一次（共两次）。
 * CLI 每次命令输出与 Web 每次操作结果都经由本函数：启动打印一次、收尾再申一次。
 */
export function echoPathline(instancePath: string, out: (line: string) => void): void {
  out(pathline(instancePath));
  out(pathline(instancePath));
}

/** 尾部路径行（与首行等值），供操作结束时输出。 */
export function trailingPathline(instancePath: string): [string, string] {
  return [pathline(instancePath), pathline(instancePath)];
}

/**
 * 守卫：text 必须包含 pathline 文本，否则抛 Error（防静默丢路径）。
 * 用于 CLI 输出与 Web 渲染结果的最终校验。
 */
export function requireVisible(text: string, instancePath: string): void {
  if (!text.includes(pathline(instancePath))) {
    throw new Error(
      `路径可见性被破坏：输出中缺少「${pathline(instancePath)}」（实例路径必须展示给用户，防静默丢失）`,
    );
  }
}
