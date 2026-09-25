import { test, expect, type Page } from '@playwright/test'

/**
 * 授权流程端到端：
 *  - happy path：假媒体 + 自动批准 -> 枚举设备 -> 主备试听 -> 武装 -> 切换 -> 停止
 *  - 拒绝路径：CDP Permission.setPermission 确定性拒绝 getUserMedia
 *
 * 只驱动真实页面，不注入任何应用假接口（假的是 Chromium 的媒体后端，不是页面接口）。
 */

async function gotoFresh(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '主备话筒切换校验台' })).toBeVisible()
}

test('授权后可枚举设备，主备试听在线，武装并完成 80ms 切换后释放', async ({ context }) => {
  const page = await context.newPage()
  await gotoFresh(page)

  // 初始：未授权，设备选择为空，武装/切换不可用。
  await expect(page.getByTestId('phase')).toContainText('待命')
  await expect(page.getByTestId('btn-arm')).toBeDisabled()
  await expect(page.getByTestId('btn-switch')).toBeDisabled()

  await page.getByTestId('btn-authorize').click()
  await expect(page.getByTestId('message')).toContainText('授权成功', { timeout: 10_000 })

  // 枚举到假音频输入设备（Chromium fake device: "Fake Audio Input"）。
  const primaryOptions = page.getByTestId('select-primary').locator('option')
  await expect(primaryOptions).not.toHaveCount(0)

  // 主路试听：状态变 live，麦克风指示打开。
  await page.getByTestId('btn-audition-primary').click()
  await expect(page.getByTestId('card-primary').locator('[data-status="live"]')).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId('mic-indicator')).toContainText('占用中')

  // 备路试听（默认 primary=设备1 / backup=设备2；单设备时也允许同设备）。
  await page.getByTestId('btn-audition-backup').click()
  await expect(page.getByTestId('card-backup').locator('[data-status="live"]')).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId('btn-arm')).toBeEnabled()

  // 武装：主路耳返输出，试听被锁定。
  await page.getByTestId('btn-arm').click()
  await expect(page.getByTestId('phase')).toContainText('主路已武装')
  await expect(page.getByTestId('onair-primary')).toBeVisible()
  await expect(page.getByTestId('btn-audition-primary')).toBeDisabled()
  await expect(page.getByTestId('btn-audition-backup')).toBeDisabled()
  await expect(page.getByTestId('btn-switch')).toBeEnabled()

  // 切换：先 switching 后 live，备路接管耳返。
  await page.getByTestId('btn-switch').click()
  await expect(page.getByTestId('phase')).toContainText('切换中')
  await expect(page.getByTestId('phase')).toContainText('备用线路播出中', { timeout: 10_000 })
  await expect(page.getByTestId('onair-backup')).toBeVisible()
  await expect(page.getByTestId('message')).toContainText('旧主路轨道与节点已释放')

  // 停止：麦克风指示必须熄灭，不残留占用。
  await page.getByTestId('btn-stop').click()
  await expect(page.getByTestId('mic-indicator')).toContainText('麦克风已释放')
  await expect(page.getByTestId('message')).toContainText('音频上下文已关闭')
  await page.close()
})

test('拒绝麦克风权限时显示拒绝原因，且不进入可武装状态', async ({ browser }) => {
  const context = await browser.newContext()
  // Chromium 假 UI 会自动接受，无法模拟用户点“阻止”。
  // 在页面脚本执行前注入一层：音频 getUserMedia 以 NotAllowedError 拒绝，
  // 这与真实权限提示被阻止时应用收到的结果完全一致。
  await context.addInitScript(() => {
    const md = navigator.mediaDevices
    const original = md.getUserMedia.bind(md)
    md.getUserMedia = function (
      constraints?: MediaStreamConstraints,
    ): Promise<MediaStream> {
      if (constraints && constraints.audio) {
        const error = new Error('Permission denied')
        ;(error as Error & { name: string }).name = 'NotAllowedError'
        return Promise.reject(error)
      }
      return original(constraints)
    }
  })
  const page = await context.newPage()

  await gotoFresh(page)
  await page.getByTestId('btn-authorize').click()
  await expect(page.getByTestId('message')).toContainText('授权被拒绝', { timeout: 10_000 })
  await expect(page.getByTestId('mic-indicator')).toContainText('麦克风已释放')
  await expect(page.getByTestId('btn-arm')).toBeDisabled()
  await context.close()
})
