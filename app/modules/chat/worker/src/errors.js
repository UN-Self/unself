// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/errors.js（GPL-3.0-only，裁剪版）
export class ApiError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

