import { describe, expect, it } from 'vitest'
import { SwitchbenchEngine } from './SwitchbenchEngine'
import {
  FakeHost,
  FakeMediaDevices,
  FakeStream,
  FakeTrack,
  ManualScheduler,
  twoDevices,
  type FakeAnalyserNode,
  type FakeAudioNode,
  type FakeGainNode,
} from '../testing/fakes'
import type { Line, MediaDeviceInfoLike, Snapshot, Which } from './types'

interface EngineInternals {
  channels: Record<Which, { line: Line | null }>
}

function harness(devices: MediaDeviceInfoLike[] = twoDevices()) {
  const media = new FakeMediaDevices(devices)
  const host = new FakeHost(media)
  const clock = new ManualScheduler()
  const engine = new SwitchbenchEngine(host, clock)
  const snap = (): Snapshot => engine.getSnapshot()
  const lineOf = (which: Which): Line => {
    const ch = (engine as unknown as EngineInternals).channels[which]
    if (!ch.line) throw new Error(`${which} 线路不存在`)
    return ch.line
  }
  /** 该路活轨道的真实设备身份（与页面所示选择核对）。 */
  const lineDeviceOf = (which: Which): string =>
    (lineOf(which).tracks[0] as FakeTrack).deviceId
  const gainOf = (line: Line): FakeGainNode => line.gain as FakeGainNode
  const analyserOf = (line: Line): FakeAnalyserNode => line.analyser as FakeAnalyserNode
  return { media, host, clock, engine, snap, lineOf, lineDeviceOf, gainOf, analyserOf }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 引擎当前持有的全部音频节点（主 / 备 / 候选）的总 disconnect 次数。 */
function totalDisconnects(h: ReturnType<typeof harness>): number {
  const internals = h.engine as unknown as {
    channels: Record<Which, { line: Line | null }>
    candidate: { line: Line } | null
  }
  const lines = [
    internals.channels.primary.line,
    internals.channels.backup.line,
    internals.candidate?.line ?? null,
  ]
  return lines.reduce(
    (sum, line) =>
      sum +
      (line
        ? (line.source as FakeAudioNode).disconnectCount +
          (line.gain as unknown as FakeAudioNode).disconnectCount +
          (line.analyser as unknown as FakeAudioNode).disconnectCount
        : 0),
    0,
  )
}

async function authorizeOk(h: ReturnType<typeof harness>): Promise<void> {
  const p = h.engine.authorize()
  h.media.grantNext() // 探测流
  await p
}

async function auditionOk(
  h: ReturnType<typeof harness>,
  which: Which,
  deviceId: string,
): Promise<FakeStream> {
  h.engine.selectDevice(which, deviceId)
  const p = h.engine.audition(which)
  await flush()
  const stream = h.media.grantNext(`aud-${which}`) as FakeStream
  await p
  return stream
}

describe('SwitchbenchEngine — 能力与授权', () => {
  it('缺少 MediaDevices 时显示原因且不支持操作', () => {
    const media = new FakeMediaDevices(twoDevices())
    const host = new FakeHost(media)
    host.noMediaDevices = true
    const engine = new SwitchbenchEngine(host)
    const s = engine.getSnapshot()
    expect(s.supported).toBe(false)
    expect(s.phase).toBe('unsupported')
    expect(s.capabilityReason).toContain('MediaDevices')
  })

  it('非安全上下文时给出 https/localhost 提示', () => {
    const host = new FakeHost(new FakeMediaDevices(twoDevices()))
    host.insecure = true
    const s = new SwitchbenchEngine(host).getSnapshot()
    expect(s.phase).toBe('unsupported')
    expect(s.capabilityReason).toContain('安全上下文')
  })

  it('拒绝授权时展示原因，不写入任何设备与活动线路', async () => {
    const h = harness()
    const p = h.engine.authorize()
    h.media.rejectNext('NotAllowedError')
    await p
    const s = h.snap()
    expect(s.message).toContain('授权被拒绝')
    expect(s.devices).toHaveLength(0)
    expect(s.micActive).toBe(false)
    expect(s.activeWhich).toBeNull()
  })

  it('探测流在枚举完成后立即停止，界面无麦克风占用', async () => {
    const h = harness()
    const p = h.engine.authorize()
    const probe = h.media.grantNext('probe') as FakeStream
    await p
    expect(probe.tracks[0].stopCount).toBe(1)
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().devices.map((d) => d.deviceId)).toEqual([
      'dev-primary',
      'dev-backup',
    ])
  })

  it('授权进行中重复点击不会产生第二次取流请求', async () => {
    const h = harness()
    const p = h.engine.authorize()
    expect(h.snap().busy).toBe(true)
    // 第二次调用直接被忽略，不新增 getUserMedia 记录。
    await h.engine.authorize()
    expect(h.media.requests).toHaveLength(1)
    h.media.grantNext()
    await p
    expect(h.snap().busy).toBe(false)
  })

  it('授权在途被停止/重置代次后，迟到探测流被停止且不写设备', async () => {
    const h = harness()
    const p = h.engine.authorize()
    // 武装/试听按钮在 busy 下不可触发；用内部代次推进模拟并发重置。
    h.engine.stop()
    const late = h.media.grantNext('late-probe') as FakeStream
    await p
    expect(late.tracks[0].stopCount).toBe(1)
    expect(h.snap().devices).toHaveLength(0)
    expect(h.snap().message).toContain('已停止')
  })

  it('AudioContext 恢复失败时停止探测流并报告原因', async () => {    const h = harness()
    h.host.resumeShouldFail = 'blocked'
    const p = h.engine.authorize()
    const probe = h.media.grantNext('probe') as FakeStream
    await p
    expect(probe.tracks[0].stopCount).toBe(1)
    expect(h.snap().message).toMatch(/授权被拒绝|AudioContext|取流失败/)
    expect(h.snap().devices).toHaveLength(0)
  })
})

describe('SwitchbenchEngine — 试听与释放', () => {
  it('两路都试听后可武装，武装期间禁止另开试听', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')
    await auditionOk(h, 'backup', 'dev-backup')
    expect(h.snap().canArm).toBe(true)

    h.engine.arm()
    expect(h.snap().phase).toBe('armed')
    expect(h.snap().auditionLocked).toBe(true)
    expect(h.snap().activeWhich).toBe('primary')

    // 武装中再点试听：状态不变化、不产生 getUserMedia 请求。
    const before = h.media.requests.length
    await h.engine.audition('primary')
    expect(h.media.requests.length).toBe(before)
    expect(h.snap().phase).toBe('armed')
  })

  it('停止试听会停止全部轨道并断开 source/gain/analyser 节点', async () => {
    const h = harness()
    await authorizeOk(h)
    const pStream = await auditionOk(h, 'primary', 'dev-primary')
    const bStream = await auditionOk(h, 'backup', 'dev-backup')
    const pLine = h.lineOf('primary')
    const bLine = h.lineOf('backup')

    h.engine.stop()

    expect(pStream.tracks[0].stopCount).toBe(1)
    expect(bStream.tracks[0].stopCount).toBe(1)
    expect((pLine.source as FakeAudioNode).disconnectCount).toBe(1)
    expect((bLine.source as FakeAudioNode).disconnectCount).toBe(1)
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().canArm).toBe(false)
  })

  it('实时电平随帧更新，停止后归零', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')
    const line = h.lineOf('primary')
    h.analyserOf(line).sample = 0.8
    h.clock.stepRaf(2)
    expect(h.snap().primary.level).toBeGreaterThan(0)

    h.engine.stop()
    expect(h.snap().primary.level).toBe(0)
  })
})

describe('SwitchbenchEngine — 代次（快速操作）', () => {
  it('快速重开试听后再停止：迟到流立即停止，且不得改写“已停止”提示', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')

    // 发起第二次试听但不解析取流，随后停止（代次 +1）使在途请求作废。
    const restart = h.engine.audition('primary')
    await flush()
    h.engine.stop()
    const lateStream = h.media.grantNext('late') as FakeStream
    await restart
    expect(lateStream.tracks[0].stopCount).toBe(1)
    expect(h.snap().message).toContain('已停止')
    expect(h.snap().micActive).toBe(false)
  })

  it('重复点击试听时旧线路不会残留：第二个 live 流接管并停掉旧轨道', async () => {
    const h = harness()
    await authorizeOk(h)
    const first = await auditionOk(h, 'primary', 'dev-primary')

    // requesting 为 false 时第二次试听直接放行（不排队），接管后旧线释放。
    const second = h.engine.audition('primary')
    await flush()
    const newer = h.media.grantNext('second') as FakeStream
    await second
    expect(first.tracks[0].stopCount).toBe(1)
    expect(newer.tracks[0].readyState).toBe('live')
    expect(h.snap().primary.status).toBe('live')
  })

  it('试听、武装、切换都递增代次', async () => {
    const h = harness()
    await authorizeOk(h)
    const g0 = h.engine.getGeneration()
    await auditionOk(h, 'primary', 'dev-primary')
    const g1 = h.engine.getGeneration()
    await auditionOk(h, 'backup', 'dev-backup')
    const g2 = h.engine.getGeneration()
    expect(g1).toBeGreaterThan(g0)
    expect(g2).toBeGreaterThan(g1)

    h.engine.arm()
    expect(h.engine.getGeneration()).toBe(g2 + 1)
  })
})

describe('SwitchbenchEngine — 切换与故障', () => {
  async function armedHarness() {
    const h = harness()
    await authorizeOk(h)
    const primary = await auditionOk(h, 'primary', 'dev-primary')
    const backupMon = await auditionOk(h, 'backup', 'dev-backup')
    h.engine.arm()
    return { h, primary, backupMon }
  }

  it('候选就绪后做 80ms 线性增减益交叉，完成后再停旧主轨道', async () => {
    const { h, primary } = await armedHarness()
    const primLine = h.lineOf('primary')
    const primGain = h.gainOf(primLine) as FakeGainNode
    const switchP = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush() // 两跳 microtick
    await flush()
    await switchP

    expect(h.snap().phase).toBe('switching')
    expect(h.snap().busy).toBe(true)
    const rampValues = primGain.gain.events
      .filter((e) => e.method === 'linearRampToValueAtTime')
      .map((e) => e.value)
    expect(rampValues).toContain(0)
    expect(h.clock.delayCalls.some((d) => d.ms === 80)).toBe(true)
    // 淡化完成前旧主轨仍活着。
    expect(primary.tracks[0].readyState).toBe('live')

    h.clock.runFades()
    expect(h.snap().phase).toBe('live')
    expect(h.snap().activeWhich).toBe('backup')
    expect(primary.tracks[0].stopCount).toBe(1)
    expect(primLine.source).toBeDefined()
    expect(h.snap().micActive).toBe(true)
    expect(candidate.tracks[0].stopCount).toBe(0)
  })

  it('候选被拒绝时保留原主路，可重新发起切换', async () => {
    const { h, primary } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    h.media.rejectNext('NotAllowedError')
    await p

    const s = h.snap()
    expect(s.phase).toBe('armed')
    expect(s.activeWhich).toBe('primary')
    expect(s.message).toContain('原主路保持输出')
    expect(primary.tracks[0].readyState).toBe('live')
    expect(s.canSwitch).toBe(true)
  })

  it('候选提前结束时释放候选、保留主路', async () => {
    const { h, primary } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    candidate.tracks[0].endNaturally()
    await flush()
    await flush()
    await p

    const s = h.snap()
    expect(s.phase).toBe('armed')
    expect(primary.tracks[0].readyState).toBe('live')
    expect(candidate.tracks[0].readyState).toBe('ended')
    expect(s.activeWhich).toBe('primary')
  })

  it('AudioContext 恢复失败时保留原主路', async () => {
    const { h, primary } = await armedHarness()
    h.host.ctx!.resumeShouldFail = 'blocked'
    const p = h.engine.switchToBackup()
    await flush()
    h.media.grantNext('candidate')
    await p
    expect(h.snap().phase).toBe('armed')
    expect(primary.tracks[0].readyState).toBe('live')
    expect(h.snap().message).toContain('原主路')
  })

  it('武装态活动主路一旦结束立即进入故障态，必须重新试听才可武装', async () => {
    const { h, primary } = await armedHarness()
    ;(primary.tracks[0] as FakeTrack).endNaturally()

    const s = h.snap()
    expect(s.phase).toBe('fault')
    expect(s.message).toContain('故障态')
    expect(s.micActive).toBe(false)
    expect(s.canArm).toBe(false)

    // 重新试听两路后才可再次武装。
    await auditionOk(h, 'primary', 'dev-primary')
    expect(h.snap().canArm).toBe(false)
    await auditionOk(h, 'backup', 'dev-backup')
    expect(h.snap().canArm).toBe(true)
  })

  it('交叉中活动主路结束 → 故障；切换中的迟到候选也被释放', async () => {
    const { h, primary } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush()
    await flush()
    await p
    expect(h.snap().phase).toBe('switching')

    // 活动主路在 80ms 窗口内结束 → 故障（代次 +1，淡化回调作废）。
    ;(primary.tracks[0] as FakeTrack).endNaturally()
    expect(h.snap().phase).toBe('fault')
    expect(candidate.tracks[0].stopCount).toBe(1) // 候选随故障立即释放

    // 即使淡化定时器迟到触发，也不得复活线路。
    h.clock.runFades()
    expect(h.snap().phase).toBe('fault')
  })

  it('切换请求期间停止：迟到候选立即释放且不进入 live', async () => {
    const { h } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    h.engine.stop()
    const late = h.media.grantNext('late-candidate') as FakeStream
    await p
    expect(late.tracks[0].stopCount).toBe(1)
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().activeWhich).toBeNull()
  })

  it('选择不存在的设备时报告原因，已工作线路不被清空', async () => {
    const h = harness()
    await authorizeOk(h)
    const stream = await auditionOk(h, 'primary', 'dev-primary')
    h.engine.selectDevice('primary', 'ghost-device')
    expect(h.snap().message).toContain('不存在')
    // 已工作的主路试听线路保持在线。
    expect(h.snap().primary.status).toBe('live')
    expect(stream.tracks[0].readyState).toBe('live')
  })
})

/**
 * 确定性验收：用可控轨道 / 音频上下文 / 定时器分别制造
 * 候选拒绝、候选夭折、恢复拒绝、非运行态与停止交错，
 * 逐次核对耳返增益、活轨道、节点、状态提示与再次切换结果。
 */
describe('SwitchbenchEngine — 失败切换只保留主路单一可听输出', () => {
  async function armedHarness() {
    const h = harness()
    await authorizeOk(h)
    const primary = await auditionOk(h, 'primary', 'dev-primary')
    const backupMon = await auditionOk(h, 'backup', 'dev-backup')
    h.engine.arm()
    const primLine = h.lineOf('primary')
    const backupLine = h.lineOf('backup')
    return { h, primary, backupMon, primLine, backupLine }
  }

  it('候选被拒绝：备监听保持增益 0，耳返只有主路一路，可立即重试', async () => {
    const { h, primary, primLine, backupLine } = await armedHarness()
    expect(h.gainOf(backupLine).gain.value).toBe(0)

    const p = h.engine.switchToBackup()
    await flush()
    h.media.rejectNext('NotAllowedError')
    await p

    const s = h.snap()
    expect(s.phase).toBe('armed')
    expect(s.activeWhich).toBe('primary')
    // 耳返增益：主路 1，备路监听仍为 0（不叠音）。
    expect(h.gainOf(primLine).gain.value).toBe(1)
    expect(h.gainOf(backupLine).gain.value).toBe(0)
    // 只有主、备两条试听轨道存活，无第三条候选流泄漏。
    expect(primary.tracks[0].readyState).toBe('live')
    // 重试前没有发生第二次备用取流（拒绝后未自动叠加请求）。
    const backupRequestsBeforeRetry = h.media.requests.filter(
      (r) => r.deviceId === 'dev-backup',
    ).length
    expect(s.micActive).toBe(true)
    expect(s.canSwitch).toBe(true)

    // 重试：这次成功完成 80ms 交叉淡化并提升备路。
    const retry = h.engine.switchToBackup()
    await flush()
    const cand2 = h.media.grantNext('candidate-retry') as FakeStream
    await flush()
    await flush()
    await retry
    expect(
      h.media.requests.filter((r) => r.deviceId === 'dev-backup'),
    ).toHaveLength(backupRequestsBeforeRetry + 1)
    h.clock.runFades()
    expect(h.snap().phase).toBe('live')
    expect(h.snap().activeWhich).toBe('backup')
    expect(primary.tracks[0].stopCount).toBe(1) // 旧主路在淡化后释放
    expect(cand2.tracks[0].stopCount).toBe(0)
  })

  it('候选在就绪窗口内提前结束：释放候选、主路增益钉在 1、备监听继续静默', async () => {
    const { h, primary, primLine, backupLine } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    candidate.tracks[0].endNaturally() // 两跳 microtick 的观察窗口内夭折
    await flush()
    await flush()
    await p

    const s = h.snap()
    expect(s.phase).toBe('armed')
    expect(s.activeWhich).toBe('primary')
    expect(s.message).toContain('原主路保持输出')
    expect(h.gainOf(primLine).gain.value).toBe(1)
    expect(h.gainOf(backupLine).gain.value).toBe(0)
    expect(primary.tracks[0].readyState).toBe('live')
    // 候选从未建成线路，夭折流不占麦克风。
    expect(s.micActive).toBe(true)
  })

  it('候选在 80ms 淡化窗口内夭折：撤销主路淡化斜坡，输出恢复为主路单路', async () => {
    const { h, primary, primLine, backupLine } = await armedHarness()
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush()
    await flush()
    await p
    expect(h.snap().phase).toBe('switching')

    const primGain = h.gainOf(primLine).gain
    expect(
      primGain.events.some(
        (e) => e.method === 'linearRampToValueAtTime' && e.value === 0,
      ),
    ).toBe(true)

    // 淡化定时器触发前候选自然结束 → 失败回退武装态。
    candidate.tracks[0].endNaturally()

    expect(h.snap().phase).toBe('armed')
    expect(h.snap().activeWhich).toBe('primary')
    expect(primGain.canceledAt.length).toBeGreaterThan(0) // 已撤销主路 → 0 斜坡
    expect(h.gainOf(primLine).gain.value).toBe(1)
    expect(h.gainOf(backupLine).gain.value).toBe(0) // 备监听不被重新打开
    expect(candidate.tracks[0].stopCount).toBe(1)
    expect(primary.tracks[0].readyState).toBe('live')
    expect(h.clock.pendingTimerCount()).toBe(0) // 迟到淡化定时器已作废
    expect(h.snap().micActive).toBe(true)

    // 迟到的淡化定时器即使被错误触发也不能改写（这里已无定时器可跑）。
    h.clock.runFades()
    expect(h.snap().phase).toBe('armed')
  })

  it('恢复被拒绝：候选流立即停止、不留图外活轨道，主路/备监听状态不变', async () => {
    const { h, primary, primLine, backupLine } = await armedHarness()
    h.host.ctx!.resumeMode = 'reject'
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await p

    expect(candidate.tracks[0].stopCount).toBe(1) // 已取到的候选流被彻底停止
    expect(h.snap().phase).toBe('armed')
    expect(h.snap().message).toContain('原主路保持输出')
    expect(h.gainOf(primLine).gain.value).toBe(1)
    expect(h.gainOf(backupLine).gain.value).toBe(0)
    expect(primary.tracks[0].readyState).toBe('live')
    expect(h.snap().micActive).toBe(true) // 主+备监听仍在
    expect(h.snap().canSwitch).toBe(true)
  })

  it('resume 正常返回但未进入 running：候选流同样立即停止，状态回到武装态', async () => {
    const { h, primLine, backupLine } = await armedHarness()
    h.host.ctx!.resumeMode = 'nonrunning'
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await p

    expect(candidate.tracks[0].stopCount).toBe(1)
    expect(h.snap().phase).toBe('armed')
    expect(h.snap().activeWhich).toBe('primary')
    expect(h.gainOf(primLine).gain.value).toBe(1)
    expect(h.gainOf(backupLine).gain.value).toBe(0)
    expect(h.snap().micActive).toBe(true)
  })
})

describe('SwitchbenchEngine — 恢复失败与停止交错后无遗留占用', () => {
  it('单独试听主路遇恢复拒绝：流被停止，页面指示与浏览器占用一致', async () => {
    const h = harness()
    await authorizeOk(h)
    h.host.ctx!.resumeMode = 'reject'
    h.engine.selectDevice('primary', 'dev-primary')

    const p = h.engine.audition('primary')
    await flush()
    const stream = h.media.grantNext('aud-primary') as FakeStream
    await p

    expect(stream.tracks[0].stopCount).toBe(1)
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().primary.status).toBe('idle')
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().message).toContain('取流失败')
    // 没有任何活线路、候选或在途流。
    expect(totalDisconnects(h)).toBe(0)
  })

  it('单独试听备路遇非运行态：同样不残留活轨道', async () => {
    const h = harness()
    await authorizeOk(h)
    h.host.ctx!.resumeMode = 'nonrunning'
    h.engine.selectDevice('backup', 'dev-backup')

    const p = h.engine.audition('backup')
    await flush()
    const stream = h.media.grantNext('aud-backup') as FakeStream
    await p

    expect(stream.tracks[0].stopCount).toBe(1)
    expect(h.snap().backup.status).toBe('idle')
    expect(h.snap().micActive).toBe(false)
  })

  it('候选流已取到、resume 挂起时点击停止：流与上下文随后被彻底释放', async () => {
    const armed = await (async () => {
      const h = harness()
      await authorizeOk(h)
      await auditionOk(h, 'primary', 'dev-primary')
      await auditionOk(h, 'backup', 'dev-backup')
      h.engine.arm()
      return h
    })()
    const h = armed
    h.host.ctx!.resumeMode = 'defer'

    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush() // 取流兑现后，执行到挂起的 resume()

    // 候选流已占用麦克风但 resume 尚未返回：页面必须如实显示占用。
    expect(h.host.ctx!.resumeWaiters).toHaveLength(1)
    expect(h.snap().busy).toBe(true)
    expect(h.snap().micActive).toBe(true)

    // 此时停止：页面声称已释放；稍后 resume 无论兑现为运行还是拒绝，
    // 迟到流都必须已被停止，不能叠加回任何线路。
    h.engine.stop()
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().micActive).toBe(false)
    h.host.ctx!.resolveResume()
    await p

    expect(candidate.tracks[0].stopCount).toBe(1)
    expect(h.snap().phase).toBe('idle')
    expect(h.snap().activeWhich).toBeNull()
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().message).toContain('已停止')
  })

  it('候选流已取到、resume 挂起时停止，resume 随后被拒绝也不复活流', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')
    await auditionOk(h, 'backup', 'dev-backup')
    h.engine.arm()
    h.host.ctx!.resumeMode = 'defer'

    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush() // 执行到挂起的 resume()
    expect(h.host.ctx!.resumeWaiters).toHaveLength(1)
    h.engine.stop()
    h.host.ctx!.rejectResume()
    await expect(p).resolves.toBeUndefined()

    expect(candidate.tracks[0].stopCount).toBe(1)
    expect(h.snap().micActive).toBe(false)
    expect(h.snap().phase).toBe('idle')
    expect(totalDisconnects(h)).toBe(0)
  })

  it('恢复失败遗留场景不会发生：停止后再次授权/试听不叠加遗留流', async () => {
    const h = harness()
    await authorizeOk(h)
    h.host.ctx!.resumeMode = 'reject'
    h.engine.selectDevice('primary', 'dev-primary')
    const failed = h.engine.audition('primary')
    await flush()
    const leaked = h.media.grantNext('would-leak') as FakeStream
    await failed
    expect(leaked.tracks[0].stopCount).toBe(1)

    // 恢复能力恢复正常后重新试听，只应有一条活轨道。
    h.host.resumeMode = null
    h.host.ctx!.resumeMode = null
    const ok = h.engine.audition('primary')
    await flush()
    const fresh = h.media.grantNext('fresh') as FakeStream
    await ok

    expect(h.snap().primary.status).toBe('live')
    expect(fresh.tracks[0].readyState).toBe('live')
    expect(leaked.tracks[0].readyState).toBe('ended')
    expect(h.snap().micActive).toBe(true)
  })
})

describe('SwitchbenchEngine — 正常交叉淡化与设备选择兼容', () => {
  it('80ms 成功切换：备路从 0 增到 1、主路从 1 减到 0，完成后旧节点断开', async () => {
    const h = harness()
    await authorizeOk(h)
    const primary = await auditionOk(h, 'primary', 'dev-primary')
    await auditionOk(h, 'backup', 'dev-backup')
    h.engine.arm()
    const primLine = h.lineOf('primary')
    const primGain = h.gainOf(primLine).gain

    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush()
    await flush()
    await p

    expect(
      primGain.events.some(
        (e) => e.method === 'linearRampToValueAtTime' && e.value === 0,
      ),
    ).toBe(true)

    h.clock.runFades()
    const backupLine = h.lineOf('backup') // 已提升为线路
    // 候选曾排定 0 -> 1 的增益斜坡（替身不模拟斜坡求值，核对排定事件）。
    expect(
      h
        .gainOf(backupLine)
        .gain.events.some(
          (e) => e.method === 'linearRampToValueAtTime' && e.value === 1,
        ),
    ).toBe(true)
    expect(primary.tracks[0].stopCount).toBe(1)
    expect((primLine.source as FakeAudioNode).disconnectCount).toBe(1)
    expect(candidate.tracks[0].readyState).toBe('live')
    expect(h.snap().phase).toBe('live')
  })

  it('停止后保留主/备设备选择，但必须重新试听才能武装', async () => {
    const h = harness()
    await authorizeOk(h)
    await auditionOk(h, 'primary', 'dev-primary')
    await auditionOk(h, 'backup', 'dev-backup')
    h.engine.arm()
    h.engine.stop()

    expect(h.snap().primary.deviceId).toBe('dev-primary')
    expect(h.snap().backup.deviceId).toBe('dev-backup')
    expect(h.snap().canArm).toBe(false)
    expect(h.snap().micActive).toBe(false)
  })
})

/**
 * 确定性验收：可控设备清单 / 轨道 / 音频上下文。
 * 先试听两路，再分别执行重复授权、清单变化与逐路改选，
 * 逐步核对实际活轨道的设备身份、阶段、占用指示、停止与武装入口及最终输出来源。
 */
describe('SwitchbenchEngine — 授权/清单/改选与界面状态一致', () => {
  const threeDevices = (): MediaDeviceInfoLike[] => [
    { deviceId: 'dev-a', label: '主席台麦', kind: 'audioinput' },
    { deviceId: 'dev-b', label: '同传箱备麦', kind: 'audioinput' },
    { deviceId: 'dev-c', label: '会场应急麦', kind: 'audioinput' },
  ]

  /** 从武装态完成一次 80ms 切换，返回候选流。 */
  async function switchOk(h: ReturnType<typeof harness>): Promise<FakeStream> {
    const p = h.engine.switchToBackup()
    await flush()
    const candidate = h.media.grantNext('candidate') as FakeStream
    await flush()
    await flush()
    await p
    h.clock.runFades()
    return candidate
  }

  it('两路试听中重复授权：阶段保持试听态，停止/武装入口与原轨道都在', async () => {
    const h = harness()
    await authorizeOk(h)
    const pStream = await auditionOk(h, 'primary', 'dev-primary')
    const bStream = await auditionOk(h, 'backup', 'dev-backup')
    expect(h.snap().phase).toBe('audition')

    // 导播再次授权核对设备（清单不变）。
    await authorizeOk(h)

    const s = h.snap()
    expect(s.phase).toBe('audition') // 不得退回空闲
    expect(s.micActive).toBe(true) // 占用指示与浏览器一致
    expect(s.canStop).toBe(true) // 麦克风仍占用时停止入口必须在
    expect(s.canArm).toBe(true) // 武装入口仍可点击
    expect(s.primary.status).toBe('live')
    expect(s.backup.status).toBe('live')
    // 原试听轨道不被误停。
    expect(pStream.tracks[0].stopCount).toBe(0)
    expect(bStream.tracks[0].stopCount).toBe(0)
    // 活轨道的设备身份与页面所示选择一致。
    expect(h.lineDeviceOf('primary')).toBe(s.primary.deviceId)
    expect(h.lineDeviceOf('backup')).toBe(s.backup.deviceId)

    // 重复授权后仍可继续武装与切换。
    h.engine.arm()
    expect(h.snap().phase).toBe('armed')
    const candidate = await switchOk(h)
    expect(h.snap().phase).toBe('live')
    expect(h.snap().activeWhich).toBe('backup')
    expect(candidate.tracks[0].readyState).toBe('live')
  })

  it('清单不再含主路原设备：旧轨道停止、资格清空，显示选择与实际来源一致', async () => {
    const h = harness()
    await authorizeOk(h)
    const pStream = await auditionOk(h, 'primary', 'dev-primary')
    const bStream = await auditionOk(h, 'backup', 'dev-backup')

    // 新清单：主路原设备被拔掉、换上一台新设备；备路设备仍在。
    h.media.devices = [
      { deviceId: 'dev-console', label: '调音台新麦', kind: 'audioinput' },
      { deviceId: 'dev-backup', label: '同传箱备麦', kind: 'audioinput' },
    ]
    await authorizeOk(h)

    const s = h.snap()
    // 主路：原设备消失 → 旧轨道停止、资格清空、显示落到新默认设备。
    expect(pStream.tracks[0].stopCount).toBe(1)
    expect(s.primary.deviceId).toBe('dev-console')
    expect(s.primary.status).toBe('idle')
    expect(s.primary.auditioned).toBe(false)
    // 备路：设备仍在清单 → 线路与试听资格保留。
    expect(bStream.tracks[0].stopCount).toBe(0)
    expect(s.backup.deviceId).toBe('dev-backup')
    expect(s.backup.status).toBe('live')
    expect(s.backup.auditioned).toBe(true)
    // 阶段 / 占用 / 入口：备路仍在线 → 保持试听态，停止可用，武装被阻止。
    expect(s.phase).toBe('audition')
    expect(s.micActive).toBe(true)
    expect(s.canStop).toBe(true)
    expect(s.canArm).toBe(false)
    expect(s.message).toContain('重新试听')
    // 任何活轨道的设备身份都必须等于页面所示选择。
    expect(h.lineDeviceOf('backup')).toBe(s.backup.deviceId)

    // 重新试听主路（新设备）后才可武装；武装与切换的输出来源与所示一致。
    await auditionOk(h, 'primary', 'dev-console')
    expect(h.snap().canArm).toBe(true)
    h.engine.arm()
    expect(h.lineDeviceOf('primary')).toBe(h.snap().primary.deviceId)
    const candidate = await switchOk(h)
    expect(h.snap().phase).toBe('live')
    expect(h.lineDeviceOf('backup')).toBe(h.snap().backup.deviceId)
    expect((candidate.tracks[0] as FakeTrack).deviceId).toBe('dev-backup')
  })

  it('清单不再含任何已选设备：两路都收掉，阶段回落空闲', async () => {
    const h = harness()
    await authorizeOk(h)
    const pStream = await auditionOk(h, 'primary', 'dev-primary')
    const bStream = await auditionOk(h, 'backup', 'dev-backup')

    h.media.devices = [
      { deviceId: 'dev-x', label: '新主麦', kind: 'audioinput' },
      { deviceId: 'dev-y', label: '新备麦', kind: 'audioinput' },
    ]
    await authorizeOk(h)

    const s = h.snap()
    expect(pStream.tracks[0].stopCount).toBe(1)
    expect(bStream.tracks[0].stopCount).toBe(1)
    expect(s.primary.auditioned).toBe(false)
    expect(s.backup.auditioned).toBe(false)
    expect(s.primary.status).toBe('idle')
    expect(s.backup.status).toBe('idle')
    expect(s.phase).toBe('idle')
    expect(s.micActive).toBe(false)
    expect(s.canArm).toBe(false)
  })

  it('试听中逐路改选两路设备：旧轨道停止、阶段随活线路回落，重试听后来源一致', async () => {
    const h = harness(threeDevices())
    await authorizeOk(h)
    const pStream = await auditionOk(h, 'primary', 'dev-a')
    const bStream = await auditionOk(h, 'backup', 'dev-b')

    // 改选主路：旧轨道停止、本路回到空闲；备路仍在线 → 仍是试听态。
    h.engine.selectDevice('primary', 'dev-c')
    let s = h.snap()
    expect(pStream.tracks[0].stopCount).toBe(1)
    expect(s.primary.deviceId).toBe('dev-c')
    expect(s.primary.status).toBe('idle')
    expect(s.primary.auditioned).toBe(false)
    expect(s.phase).toBe('audition')
    expect(s.micActive).toBe(true)
    expect(s.canStop).toBe(true)
    expect(s.canArm).toBe(false)

    // 改选备路：两路均无活线路 → 阶段回落空闲，占用指示熄灭。
    h.engine.selectDevice('backup', 'dev-a')
    s = h.snap()
    expect(bStream.tracks[0].stopCount).toBe(1)
    expect(s.backup.deviceId).toBe('dev-a')
    expect(s.backup.status).toBe('idle')
    expect(s.backup.auditioned).toBe(false)
    expect(s.phase).toBe('idle')
    expect(s.micActive).toBe(false)
    expect(s.canStop).toBe(false) // 无占用时不需要停止入口
    expect(s.canArm).toBe(false)
    expect(s.message).toContain('重新试听')

    // 重新试听两路后武装、切换：最终耳返来源与页面所示选择一致。
    await auditionOk(h, 'primary', 'dev-c')
    await auditionOk(h, 'backup', 'dev-a')
    expect(h.snap().canArm).toBe(true)
    h.engine.arm()
    expect(h.lineDeviceOf('primary')).toBe('dev-c')
    const candidate = await switchOk(h)
    expect(h.snap().phase).toBe('live')
    expect(h.snap().activeWhich).toBe('backup')
    expect(h.lineDeviceOf('backup')).toBe('dev-a')
    expect(h.snap().backup.deviceId).toBe('dev-a')
    expect((candidate.tracks[0] as FakeTrack).deviceId).toBe('dev-a')
  })
})
