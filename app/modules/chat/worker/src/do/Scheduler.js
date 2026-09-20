// SPDX-License-Identifier: GPL-3.0-only
// Source: aozorae/Edgechat@29978c221ee3ae641ce0b9b97851656c00714a5d worker/src/do/Scheduler.js（GPL-3.0-only，裁剪版）
import { nextDailyUtcHour } from '../utils.js';
import { runScheduledGc } from '../gc.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';

export class Scheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'Scheduler');
    if (health) return health;
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      await this.state.storage.setAlarm(nextDailyUtcHour(3));
    }

    return new Response('ok');
  }

  async alarm() {
    await runScheduledGc(this.env);

    await this.state.storage.setAlarm(nextDailyUtcHour(3));
  }
}
