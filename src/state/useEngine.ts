import { useSyncExternalStore } from 'react'
import { BrowserHost } from '../domain/browserHost'
import { SwitchbenchEngine } from '../domain/SwitchbenchEngine'
import type { Snapshot } from '../domain/types'

/**
 * 引擎单例：使用真实浏览器宿主（禁止假接口）。
 * React StrictMode 下重复挂载也只是重复订阅，不会产生额外设备会话。
 */
const engine = new SwitchbenchEngine(new BrowserHost())

export function useSnapshot(): Snapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot)
}

export { engine }
