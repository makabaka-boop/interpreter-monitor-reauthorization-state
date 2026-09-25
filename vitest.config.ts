import { defineConfig } from 'vitest/config'

// 引擎单测在 Node 中使用可完全控制的媒体替身（见 src/testing/fakes.ts），
// 不触达真实浏览器设备；reporter 在 docker verify 中保持默认。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
})
