/**
 * SessionPointer 的两个实现。
 *
 * - localStorage：浏览器里记住「上次停在哪」，刷新后回到原会话（Day 5 / E4）。
 * - memory：测试用，避免测试依赖浏览器环境。
 */

import type { SessionPointer } from './types';

const STORAGE_KEY = 'wendy-agent-chat:active-session';

/**
 * 浏览器实现。
 *
 * 所有访问都包 try/catch：隐私模式、存储配额满、被禁用时 `localStorage` 会直接抛错，
 * 不能因为"记住位置"这种附属功能把整个应用弄崩。
 */
export function createLocalStoragePointer(storage?: Storage): SessionPointer {
  const safeStorage = (): Storage | null => {
    if (storage !== undefined) return storage;
    if (typeof window === 'undefined') return null;

    return window.localStorage;
  };

  return {
    read() {
      try {
        return safeStorage()?.getItem(STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(id) {
      try {
        const store = safeStorage();
        if (!store) return;
        if (id === null) store.removeItem(STORAGE_KEY);
        else store.setItem(STORAGE_KEY, id);
      } catch {
        // 存不进去就算了：下次刷新回到默认会话，不影响本次使用
      }
    },
  };
}

/** 测试用：进程内记住一个 id。 */
export function createMemoryPointer(initial: string | null = null): SessionPointer {
  let value = initial;

  return {
    read: () => value,
    write: (id) => {
      value = id;
    },
  };
}
