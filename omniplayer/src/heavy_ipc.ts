/**
 * 重 IPC：单飞扫盘 + 播放器域可取消（离开播放器后丢弃结果，避免与仪表盘争用）。
 */

/** 2：播放器列表不必卡在已离开页的 dashboard_health 后面；再高会扫盘互抢。 */
const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];
let playerHeavyGen = 0;

export function cancelPlayerHeavyIpc() {
  playerHeavyGen++;
}

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

function playerStale(playerGen: number, playerScope?: boolean) {
  return playerScope === true && playerGen !== playerHeavyGen;
}

export function runHeavyIpc<T>(
  _label: string,
  fn: () => Promise<T>,
  opts?: { cancelled?: () => boolean; playerScope?: boolean }
): Promise<T> {
  if (opts?.cancelled?.()) {
    return Promise.reject(new Error("cancelled"));
  }
  const playerGen = opts?.playerScope ? playerHeavyGen : -1;
  return acquire().then(() => {
    if (
      opts?.cancelled?.() ||
      playerStale(playerGen, opts?.playerScope)
    ) {
      release();
      return Promise.reject(new Error("cancelled"));
    }
    return fn().then(
      (v) => {
        release();
        if (playerStale(playerGen, opts?.playerScope)) {
          throw new Error("cancelled");
        }
        return v;
      },
      (e) => {
        release();
        throw e;
      }
    );
  });
}
