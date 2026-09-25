import { defineConfig, devices } from '@playwright/test'

/**
 * 端到端测试需要 Chromium 的假媒体（--use-fake-ui-for-media-stream +
 * --use-fake-device-for-media-stream）才能确定性地走完授权 / 试听 / 武装 / 切换。
 * Docker verify 中 webServer 复用同一容器里的 vite。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--allow-file-access-from-files',
          ],
        },
        contextOptions: {
          permissions: ['microphone'],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 8080 --strictPort',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
