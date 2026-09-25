import {
  describeCapabilityError,
  describeMediaError,
  devicesMatch,
  streamHasLiveAudio,
} from './browserHost'
import {
  CROSSFADE_MS,
  type AudioContextLike,
  type ChannelView,
  type Host,
  type Line,
  type MediaDeviceInfoLike,
  type MediaStreamLike,
  type MediaStreamTrackLike,
  type MediaStreamConstraintsLike,
  type Phase,
  type Snapshot,
  type TrackStatus,
  type Which,
} from './types'

/** 可注入的时序面：默认走浏览器；测试中用可控帧/定时器替身。 */
export interface Scheduler {
  raf(cb: () => void): number
  cancelRaf(id: number): void
  delay(ms: number, cb: () => void): number
  cancelDelay(id: number): void
  microtick(): Promise<void>
}

export const defaultScheduler: Scheduler = {
  raf: (cb) => globalThis.requestAnimationFrame(cb),
  cancelRaf: (id) => globalThis.cancelAnimationFrame(id),
  delay: (ms, cb) => globalThis.setTimeout(cb, ms) as unknown as number,
  cancelDelay: (id) => globalThis.clearTimeout(id),
  microtick: () => Promise.resolve(),
}

interface InternalLine extends Line {
  which: Which
  meterId: number | null
  endFns: Array<[MediaStreamTrackLike, () => void]>
}

interface ChannelRuntime {
  deviceId: string
  deviceLabel: string
  line: InternalLine | null
  requesting: boolean
  auditioned: boolean
  level: number
}

const emptyChannel = (): ChannelRuntime => ({
  deviceId: '',
  deviceLabel: '',
  line: null,
  requesting: false,
  auditioned: false,
  level: 0,
})

const LABEL: Record<Which, string> = { primary: '主路', backup: '备路' }

/**
 * 主备话筒切换引擎。UI 只读快照（React useSyncExternalStore），
 * 所有写操作都经过代次（generation）守卫。
 */
export class SwitchbenchEngine {
  private host: Host
  private scheduler: Scheduler

  private phase: Phase = 'idle'
  private generation = 0
  private message = ''
  private devices: MediaDeviceInfoLike[] = []

  private channels: Record<Which, ChannelRuntime> = {
    primary: emptyChannel(),
    backup: emptyChannel(),
  }

  /** 当前活动（正在对外输出）的线路归属。 */
  private activeWhich: Which | null = null
  /** 切换过程中的备用候选；就绪、淡化、提升都围绕它。 */
  private candidate: { gen: number; line: InternalLine } | null = null
  private fadeTimer: number | null = null
  /**
   * 已从 getUserMedia 取到、但尚未建成线路（或尚未被代次否决）的在途流。
   * 它们真实占用着麦克风，必须计入 micActive；建线时转交线路、放弃时立即停止。
   */
  private inflightStreams = new Set<MediaStreamLike>()

  private ctx: AudioContextLike | null = null
  private supported = true
  private capabilityReason = ''
  private authorizing = false

  private listeners = new Set<() => void>()
  private cached: Snapshot

  constructor(host: Host, scheduler: Scheduler = defaultScheduler) {
    this.host = host
    this.scheduler = scheduler
    const md = host.mediaDevices()
    if (!host.isSecureContext()) {
      this.markUnsupported(describeCapabilityError('insecure'))
    } else if (!md) {
      this.markUnsupported(describeCapabilityError('no-media-devices'))
    } else if (!host.AudioContextCtor()) {
      this.markUnsupported(describeCapabilityError('no-audio-context'))
    }
    this.cached = this.buildSnapshot()
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): Snapshot => this.cached

  getGeneration(): number {
    return this.generation
  }

  private publish(): void {
    this.cached = this.buildSnapshot()
    this.listeners.forEach((fn) => fn())
  }

  // ---------------------------------------------------------------- 授权

  /**
   * 请求麦克风授权：先取一条探测流，恢复 AudioContext，再枚举设备。
   * 探测流无论结果如何都会被停止；连续点击时仅最新一次可写入设备列表。
   */
  async authorize(): Promise<void> {
    if (!this.supported || this.isBusy() || this.authorizing) return
    // 武装 / 切换 / 播出中不允许重新授权打乱活动线路。
    if (this.phase === 'armed' || this.phase === 'switching' || this.phase === 'live') return
    const md = this.host.mediaDevices()
    if (!md) return

    const gen = ++this.generation
    this.authorizing = true
    this.message = '正在请求麦克风授权…'
    this.publish()

    try {
      let probe: MediaStreamLike | null = null
      try {
        probe = await md.getUserMedia({ audio: true })
        this.inflightStreams.add(probe)
        if (gen !== this.generation) {
          this.discardStream(probe)
          return
        }

        const ctx = this.ensureCtx()
        await ctx.resume()
        if (gen !== this.generation) {
          this.discardStream(probe)
          return
        }
        if (ctx.state !== 'running') {
          this.discardStream(probe)
          throw new ResumeError('AudioContext 未进入 running 状态')
        }

        const listed = await md.enumerateDevices()
        if (gen !== this.generation) {
          this.discardStream(probe)
          return
        }

        // 授权探测完成，立即归还探测流（标签在授权后仍可枚举到）。
        this.discardStream(probe)
        probe = null

        this.devices = listed.filter(
          (d) => d.kind === 'audioinput' && d.deviceId !== '',
        ) as MediaDeviceInfoLike[]
        // 让每路的“显示选择 / 活轨道 / 试听资格”与新清单对齐：
        // 原设备消失的路会被收掉线路并要求重新试听。
        const resetPrimary = this.reconcileWithDevices('primary')
        const resetBackup = this.reconcileWithDevices('backup')

        // 故障态下重新授权等价于回到可重新试听的起点。
        if (this.phase === 'fault') {
          this.activeWhich = null
        }
        // 仍有试听线路在线时必须保持试听态：阶段如实反映麦克风占用，
        // 停止入口才不会在轨道仍存活时被禁用。
        this.phase = this.anyLiveMonitor() ? 'audition' : 'idle'
        const resetNames = [
          resetPrimary ? LABEL.primary : '',
          resetBackup ? LABEL.backup : '',
        ].filter(Boolean)
        this.message =
          this.devices.length > 0
            ? `授权成功，发现 ${this.devices.length} 个音频输入设备。` +
              (resetNames.length > 0
                ? `${resetNames.join('、')}原设备已不在清单中，其试听线路已停止，请重新试听。`
                : this.anyLiveMonitor()
                  ? '在线试听线路保持不变。'
                  : '请分别选择主、备输入。')
            : '授权成功，但未枚举到任何音频输入设备。'
        this.publish()
      } catch (error) {
        if (probe) this.discardStream(probe)
        if (gen !== this.generation) return // 较早代次不得改写提示
        this.message = describeMediaError(error)
        this.publish()
      }
    } finally {
      this.authorizing = false
      this.publish()
    }
  }

  // ---------------------------------------------------------------- 设备

  selectDevice(which: Which, deviceId: string): void {
    if (!this.supported) return
    const ch = this.channels[which]
    if (ch.requesting) return
    // 武装 / 切换 / 播出中不允许换设备；试听中换设备先停掉本路。
    if (this.phase === 'armed' || this.phase === 'switching' || this.phase === 'live') return
    const device = devicesMatch(this.devices, deviceId)
    if (!device) {
      this.message = describeMediaError({ name: 'NotFoundError' })
      this.publish()
      return
    }
    const hadState = ch.line !== null || ch.auditioned
    if (ch.line) {
      // 改选设备：原试听轨道的来源已不等于新选择，必须停止并释放，
      // 且清空引用——否则界面会把已释放线路继续显示为本路状态。
      this.releaseLine(ch.line)
      ch.line = null
    }
    ch.deviceId = device.deviceId
    ch.deviceLabel = device.label || `${LABEL[which]}设备 ${device.deviceId.slice(0, 6) || ''}`
    ch.auditioned = false
    ch.level = 0
    // 两路都没有活线路时回到空闲态：操作员可据状态判断必须重新试听。
    if (this.phase === 'audition' && !this.anyLiveMonitor()) this.phase = 'idle'
    this.message = hadState
      ? `已改选${LABEL[which]}为「${ch.deviceLabel}」，原试听线路已停止，请重新试听。`
      : `已选择${LABEL[which]}：${ch.deviceLabel}。`
    this.publish()
  }

  // ---------------------------------------------------------------- 试听

  /**
   * 启动某一路试听。武装 / 切换 / 播出期间一律拒绝（武装期间禁止另开试听）。
   * 故障态下试听即重新建立线路，成功后必须重新试听齐两路才可武装。
   */
  async audition(which: Which): Promise<void> {
    if (!this.supported) return
    if (this.phase === 'armed' || this.phase === 'switching' || this.phase === 'live') return
    const ch = this.channels[which]
    if (ch.requesting) return
    const device = devicesMatch(this.devices, ch.deviceId)
    if (!device) {
      this.message = describeMediaError({ name: 'NotFoundError' })
      this.publish()
      return
    }

    const gen = ++this.generation
    ch.requesting = true
    this.message = `正在启动${LABEL[which]}试听…`
    this.publish()

    let stream: MediaStreamLike | null = null
    let ctx: AudioContextLike | null = null
    const invalidateStale = (lateStream: MediaStreamLike | null): void => {
      ch.requesting = false
      if (lateStream) this.discardStream(lateStream)
      if (ctx) this.disposeCtxIfUnused(ctx)
    }
    try {
      stream = await this.requestStream(ch.deviceId)
      this.inflightStreams.add(stream)
      if (gen !== this.generation) {
        invalidateStale(stream)
        return
      }
      ctx = this.ensureCtx()
      await ctx.resume()
      if (gen !== this.generation) {
        invalidateStale(stream)
        return
      }
      if (ctx.state !== 'running') throw new ResumeError('AudioContext 恢复失败')
      if (!streamHasLiveAudio(stream)) throw { name: 'NotFoundError' }

      // 重复试听：先释放本路旧线路，再接管。
      if (ch.line) this.releaseLine(ch.line)
      const line = this.buildLine(which, stream)
      ch.line = line
      ch.requesting = false
      ch.auditioned = true

      if (this.phase === 'fault') {
        this.phase = 'idle'
        this.activeWhich = null
      }
      if (this.phase === 'idle') this.phase = 'audition'
      this.message = `${LABEL[which]}（${ch.deviceLabel}）试听中，电平表应随声音跳动。`
      this.publish()
    } catch (error) {
      if (gen !== this.generation) {
        // 较早代次：立即停止刚拿到的流，且不得改写提示。
        invalidateStale(stream)
        return
      }
      // 当前代次失败（恢复被拒绝 / 未进入 running / 无活轨道）：
      // 已取到的流绝不能留在图外占用麦克风。
      if (stream) this.discardStream(stream)
      ch.requesting = false
      if (ctx) this.disposeCtxIfUnused(ctx)
      this.message = `${LABEL[which]}取流失败：${describeMediaError(error)}`
      this.publish()
    }
  }

  // ---------------------------------------------------------------- 武装

  /** 两路试听均在线后武装主路；武装期间禁止另开试听。 */
  arm(): void {
    if (!this.supported || !this.canArmInternal()) return
    this.generation++
    this.phase = 'armed'
    this.activeWhich = 'primary'
    // 主路成为耳返输出，备路监听静音待机（切换失败时恢复）。
    const backupMon = this.channels.backup.line
    if (backupMon) this.setMuted(backupMon, true)
    this.message = '主路已武装并持续输出；备用静默待机。武装期间不能再开试听。'
    this.publish()
  }

  // ---------------------------------------------------------------- 切换

  /**
   * 发起主 -> 备切换：
   *  1. 重新申请备用候选流（拒绝 / 提前结束 / 恢复失败都保留原主路）；
   *  2. 候选就绪后做 80ms 线性增减益交叉；
   *  3. 交叉完成再停止旧主路轨道、断开旧节点。
   */
  async switchToBackup(): Promise<void> {
    if (!this.supported || this.phase !== 'armed' || this.isBusy()) return
    const backup = this.channels.backup
    const primary = this.channels.primary

    const gen = ++this.generation
    this.phase = 'switching'
    this.message = '正在向备用输入发起候选请求…'
    this.publish()

    let stream: MediaStreamLike | null = null
    let ctx: AudioContextLike | null = null
    try {
      stream = await this.requestStream(backup.deviceId)
      this.inflightStreams.add(stream)
      if (gen !== this.generation) {
        if (stream) this.discardStream(stream) // 迟到候选：立即释放，不写提示
        return
      }

      ctx = this.ensureCtx()
      await ctx.resume()
      if (gen !== this.generation) {
        if (stream) this.discardStream(stream)
        if (ctx) this.disposeCtxIfUnused(ctx)
        return
      }
      if (ctx.state !== 'running') throw new ResumeError('AudioContext 恢复失败')

      // 两跳微任务，给设备夭折 / readyState 翻转留出观察窗口。
      await this.scheduler.microtick()
      await this.scheduler.microtick()
      if (gen !== this.generation) {
        if (stream) this.discardStream(stream)
        if (ctx) this.disposeCtxIfUnused(ctx)
        return
      }
      if (!streamHasLiveAudio(stream)) {
        throw { name: 'NotFoundError', message: '候选轨道未就绪' }
      }

      // 候选就绪：建增益 0 的线路，电平表切到候选。
      const candidate = this.buildLine('backup', stream, { startGain: 0 })
      // 流已由候选线路接管，不再计入“在途”。
      stream = null
      this.candidate = { gen, line: candidate }
      const oldMonitor = backup.line
      if (oldMonitor && oldMonitor !== candidate) this.stopMeter(oldMonitor)

      this.message = '备用候选就绪，开始 80ms 线性交叉淡化…'
      this.publish()

      const primLine = primary.line
      const t0 = ctx.currentTime
      candidate.gain.gain.setValueAtTime(0, t0)
      candidate.gain.gain.linearRampToValueAtTime(1, t0 + CROSSFADE_MS / 1000)
      if (primLine) {
        primLine.gain.gain.setValueAtTime(1, t0)
        primLine.gain.gain.linearRampToValueAtTime(0, t0 + CROSSFADE_MS / 1000)
      }

      this.fadeTimer = this.scheduler.delay(CROSSFADE_MS, () => {
        this.fadeTimer = null
        if (gen !== this.generation || this.candidate?.line !== candidate) {
          // 交叉期间已故障 / 被停止：迟到候选立即释放。
          if (!candidate.released) this.releaseLine(candidate)
          if (this.candidate?.line === candidate) this.candidate = null
          return
        }
        // 淡化完成：先提升候选为活动主路，再停止旧轨道、断开旧节点。
        backup.line = candidate
        this.activeWhich = 'backup'
        this.candidate = null
        if (oldMonitor && oldMonitor !== candidate) this.releaseLine(oldMonitor)
        if (primLine) {
          this.releaseLine(primLine)
          if (primary.line === primLine) primary.line = null
        }
        primary.auditioned = false
        this.phase = 'live'
        this.message = '已切换到备用线路持续输出，旧主路轨道与节点已释放。'
        this.publish()
      })
    } catch (error) {
      if (stream && gen !== this.generation) {
        this.discardStream(stream)
        return
      }
      if (gen !== this.generation) return
      // 候选已取到但恢复被拒绝 / 未进入 running / 未就绪：立即释放候选流，
      // 不得留下图外活轨道占用麦克风，再保留主路回到武装态。
      if (stream) this.discardStream(stream)
      if (ctx) this.disposeCtxIfUnused(ctx)
      this.abortSwitchRetainingPrimary(
        `备用候选被拒绝或无法就绪（${describeMediaError(error)}），原主路保持输出。`,
      )
    }
  }

  /**
   * 候选拒绝 / 提前结束 / 恢复失败：释放候选，回到武装态，主路不动。
   * 关键不变量：
   *  - 只保留主路一路可听输出：主路增益必须恢复为 1（撤销可能已排定的淡化斜坡）；
   *  - 备路监听继续静默（保持武装时的 0 增益），绝不与主路同时送进耳返。
   */
  private abortSwitchRetainingPrimary(reason: string): void {
    if (this.fadeTimer !== null) {
      this.scheduler.cancelDelay(this.fadeTimer)
      this.fadeTimer = null
    }
    if (this.candidate) {
      this.releaseLine(this.candidate.line)
      this.candidate = null
    }
    const primLine = this.channels.primary.line
    if (primLine && this.ctx && this.ctx.state !== 'closed') {
      // 候选可能在 80ms 淡化窗口内夭折：撤销主路 -> 0 的排定斜坡并钉回 1。
      try {
        primLine.gain.gain.cancelScheduledValues(this.ctx.currentTime)
      } catch {
        // 真实浏览器在已关闭的上下文上会抛错，忽略。
      }
      primLine.gain.gain.value = 1
      primLine.muted = false
    }
    const backupMon = this.channels.backup.line
    if (backupMon) {
      // 备路监听维持武装时的静默（增益 0），只恢复其电平表轮询。
      backupMon.muted = true
      backupMon.gain.gain.value = 0
      this.startMeter(backupMon)
    }
    this.phase = 'armed'
    this.activeWhich = 'primary'
    this.message = reason
    this.publish()
  }

  // ---------------------------------------------------------------- 停止

  /**
   * 停止一切：递增代次使所有在途回调失效，停止全部轨道、断开全部节点、
   * 关闭 AudioContext。界面不得残留麦克风占用。
   */
  stop(): void {
    this.generation++
    this.releaseAll()
    this.channels.primary = emptyChannel()
    this.channels.backup = emptyChannel()
    // 保留设备选择方便重试；但试听资格清空，必须重新试听齐两路。
    this.channels.primary.deviceId = this.lastPrimaryId
    this.channels.primary.deviceLabel = this.lastPrimaryLabel
    this.channels.backup.deviceId = this.lastBackupId
    this.channels.backup.deviceLabel = this.lastBackupLabel
    this.activeWhich = null
    this.candidate = null
    this.phase = 'idle'
    this.message = '已停止：全部轨道已停止、节点已断开、音频上下文已关闭。'
    this.publish()
  }

  // ------------------------------------------------------------- 轨道事件

  private handleTrackEnded(line: InternalLine): void {
    if (line.released) return

    // 活动主路（武装后的主路 / 交叉中仍在输出的主路 / 已提升的备路）结束 → 故障。
    if (this.activeLine() === line) {
      this.enterFault(
        line.which === 'primary'
          ? '活动主路轨道已结束，进入故障态。请重新试听主、备线路后再武装。'
          : '活动备用线路轨道已结束，进入故障态。请重新试听主、备线路后再武装。',
      )
      return
    }

    // 切换候选在提升前夭折：保留原主路。
    if (this.candidate?.line === line) {
      this.releaseLine(line)
      this.candidate = null
      this.abortSwitchRetainingPrimary(
        '备用候选提前结束，原主路保持输出；可重新发起切换。',
      )
      return
    }

    // 普通试听 / 监听线路自然结束：仅收掉本路。
    this.releaseLine(line)
    const ch = this.channels[line.which]
    if (ch.line === line) {
      ch.line = null
      ch.level = 0
    }
    if (this.phase === 'audition' && !this.anyLiveMonitor()) {
      this.phase = 'idle'
      this.message = '试听线路已结束。'
    } else if (this.phase === 'armed' && line.which === 'backup') {
      this.message = '备用监听已结束（主路仍输出）；发起切换时会重新取流。'
    }
    this.publish()
  }

  private enterFault(reason: string): void {
    // 故障递增代次：所有在途试听 / 候选 / 淡化回调即刻失效并释放。
    this.generation++
    this.releaseAll()
    this.candidate = null
    this.activeWhich = null
    this.channels.primary.auditioned = false
    this.channels.backup.auditioned = false
    this.channels.primary.requesting = false
    this.channels.backup.requesting = false
    this.phase = 'fault'
    this.message = reason
    this.publish()
  }

  // ------------------------------------------------------------- 音频管线

  private ensureCtx(): AudioContextLike {
    if (!this.ctx) {
      const ctx = this.host.newAudioContext()
      if (!ctx) throw new ResumeError('无法创建 AudioContext')
      this.ctx = ctx
    }
    return this.ctx
  }

  private requestStream(deviceId: string): Promise<MediaStreamLike> {
    const constraints: MediaStreamConstraintsLike = {
      audio: { deviceId: { exact: deviceId } },
    }
    return this.host.mediaDevices()!.getUserMedia(constraints)
  }

  private buildLine(
    which: Which,
    stream: MediaStreamLike,
    opts: { startGain?: number } = {},
  ): InternalLine {
    // 流即将由线路接管：从在途占用登记中摘除（幂等，试听流可能未登记）。
    this.inflightStreams.delete(stream)
    const ctx = this.ensureCtx()
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    gain.gain.value = opts.startGain ?? 1
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(gain)
    gain.connect(analyser)
    analyser.connect(ctx.destination)

    const line: InternalLine = {
      stream,
      tracks: stream.getAudioTracks(),
      source,
      gain,
      analyser,
      muted: (opts.startGain ?? 1) === 0,
      released: false,
      which,
      meterId: null,
      endFns: [],
    }
    for (const track of stream.getTracks()) {
      if (track.kind !== 'audio') continue
      const fn = (): void => this.handleTrackEnded(line)
      track.addEventListener('ended', fn)
      line.endFns.push([track, fn])
    }
    this.startMeter(line)
    return line
  }

  private setMuted(line: InternalLine, muted: boolean): void {
    line.muted = muted
    line.gain.gain.value = muted ? 0 : 1
  }

  private startMeter(line: InternalLine): void {
    if (line.meterId !== null) this.scheduler.cancelRaf(line.meterId)
    const buf = new Uint8Array(line.analyser.fftSize)
    const tick = (): void => {
      if (line.released) return
      line.analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.min(1, Math.sqrt(sum / buf.length) * 2.5)
      const ch = this.channels[line.which]
      // 旧的备路监听在切换中已不再驱动电平表（由候选接管）。
      const drivesBackupMeter =
        line.which !== 'backup' || !this.candidate || this.candidate.line === line
      if (drivesBackupMeter && (ch.line === line || this.candidate?.line === line)) {
        ch.level = rms
        // 帧数据是快照的一部分，rAF 在渲染之外，直接发布以刷新电平表。
        this.publish()
      }
      line.meterId = this.scheduler.raf(tick)
    }
    line.meterId = this.scheduler.raf(tick)
  }

  private stopMeter(line: InternalLine): void {
    if (line.meterId !== null) {
      this.scheduler.cancelRaf(line.meterId)
      line.meterId = null
    }
  }

  private releaseLine(line: InternalLine | null): void {
    if (!line || line.released) return
    this.stopMeter(line)
    for (const [track, fn] of line.endFns) {
      track.removeEventListener('ended', fn)
    }
    line.endFns = []
    for (const track of line.tracks) track.stop()
    try {
      line.source.disconnect()
      line.gain.disconnect()
      line.analyser.disconnect()
    } catch {
      // 节点已随上下文关闭时忽略。
    }
    line.released = true
    const ch = this.channels[line.which]
    if (ch.line === line) ch.level = 0
  }

  private releaseAll(): void {
    if (this.fadeTimer !== null) {
      this.scheduler.cancelDelay(this.fadeTimer)
      this.fadeTimer = null
    }
    // 已取到但尚未建成线路的在途流（如恢复失败窗口内停止）：一并停止，
    // 否则浏览器麦克风指示会在页面显示“已释放”后仍然亮着。
    for (const pending of this.inflightStreams) this.stopStream(pending)
    this.inflightStreams.clear()
    this.releaseLine(this.channels.primary.line)
    this.releaseLine(this.channels.backup.line)
    if (this.candidate) {
      this.releaseLine(this.candidate.line)
      this.candidate = null
    }
    this.channels.primary.line = null
    this.channels.backup.line = null
    this.channels.primary.level = 0
    this.channels.backup.level = 0
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => undefined)
    }
    this.ctx = null
  }

  private stopStream(stream: MediaStreamLike): void {
    for (const track of stream.getTracks()) track.stop()
  }

  /**
   * 放弃一条已取到的在途流：从占用登记中摘除并停止其全部轨道。
   * 任何“流已拿到、却不能接管线路”的路径都必须经此归还，避免图外泄漏。
   * 幂等：已被停止 / releaseAll 回收过的流再次放弃时不重复 stop。
   */
  private discardStream(stream: MediaStreamLike): void {
    if (!this.inflightStreams.delete(stream)) return
    this.stopStream(stream)
  }

  /**
   * 迟到回调路径上的上下文回收：仅当这个 ctx 仍是当前 ctx、
   * 没有任何线路 / 候选 / 在途请求使用它时才关闭，避免误杀并发操作。
   */
  private disposeCtxIfUnused(ctx: AudioContextLike): void {
    if (this.ctx !== ctx) return
    if (this.channels.primary.line || this.channels.backup.line || this.candidate) return
    if (
      this.channels.primary.requesting ||
      this.channels.backup.requesting ||
      this.authorizing
    ) {
      return
    }
    if (ctx.state !== 'closed') void ctx.close().catch(() => undefined)
    this.ctx = null
  }

  // ---------------------------------------------------------------- 辅助

  private lastPrimaryId = ''
  private lastPrimaryLabel = ''
  private lastBackupId = ''
  private lastBackupLabel = ''

  /**
   * 授权刷新设备清单后，让单路的“显示选择 / 活轨道 / 试听资格”保持一致：
   *  - 原设备仍在清单中：保留选择与线路，仅刷新标签；
   *  - 原设备已不在清单：该路活轨道的真实来源已不等于任何可展示的选择，
   *    必须停止并释放、清空试听资格，再落到默认选择，要求重新试听——
   *    否则武装后耳返的实际来源会与页面所示设备不符。
   * 返回值：是否确实收掉了该路已建立的线路 / 试听资格（用于提示）。
   */
  private reconcileWithDevices(which: Which): boolean {
    const ch = this.channels[which]
    if (devicesMatch(this.devices, ch.deviceId)) {
      this.applyDefaultSelection(which)
      return false
    }
    const hadState = ch.line !== null || ch.auditioned
    if (ch.line) {
      this.releaseLine(ch.line)
      ch.line = null
    }
    ch.auditioned = false
    ch.level = 0
    this.applyDefaultSelection(which)
    return hadState
  }

  private applyDefaultSelection(which: Which): void {
    const ch = this.channels[which]
    const keep = devicesMatch(this.devices, ch.deviceId)
    if (keep) {
      ch.deviceLabel = keep.label
      return
    }
    // 主默认第一个，备默认第二个（不足时与主相同，由用户自行改选）。
    const idx = which === 'primary' ? 0 : 1
    const pick = this.devices[idx] ?? this.devices[0]
    if (pick) {
      ch.deviceId = pick.deviceId
      ch.deviceLabel = pick.label || `${LABEL[which]}设备`
    } else {
      ch.deviceId = ''
      ch.deviceLabel = ''
    }
    if (which === 'primary') {
      this.lastPrimaryId = ch.deviceId
      this.lastPrimaryLabel = ch.deviceLabel
    } else {
      this.lastBackupId = ch.deviceId
      this.lastBackupLabel = ch.deviceLabel
    }
  }

  private activeLine(): InternalLine | null {
    if (!this.activeWhich) return null
    const line = this.channels[this.activeWhich].line
    return line && !line.released ? line : null
  }

  private anyLiveMonitor(): boolean {
    const live = (w: Which): boolean => {
      const line = this.channels[w].line
      return !!line && !line.released
    }
    return live('primary') || live('backup')
  }

  private isBusy(): boolean {
    return (
      this.authorizing ||
      this.phase === 'switching' ||
      this.channels.primary.requesting ||
      this.channels.backup.requesting
    )
  }

  private canArmInternal(): boolean {
    if (this.phase !== 'audition' && this.phase !== 'idle') return false
    if (this.isBusy()) return false
    const live = (w: Which): boolean => {
      const line = this.channels[w].line
      return !!line && !line.released && line.tracks.some((t) => t.readyState === 'live')
    }
    return (
      this.channels.primary.auditioned &&
      this.channels.backup.auditioned &&
      live('primary') &&
      live('backup')
    )
  }

  private markUnsupported(reason: string): void {
    this.supported = false
    this.capabilityReason = reason
    this.phase = 'unsupported'
  }

  private statusOf(which: Which): TrackStatus {
    const ch = this.channels[which]
    if (ch.requesting) return 'requesting'
    const line = ch.line
    if (!line) return 'idle'
    if (line.released) return 'released'
    if (line.tracks.every((t) => t.readyState === 'ended')) return 'ended'
    if (this.phase === 'switching' && this.activeWhich === which && which === 'primary') {
      return 'stopping'
    }
    return 'live'
  }

  private viewOf(which: Which): ChannelView {
    const ch = this.channels[which]
    // 切换中备路电平跟随候选。
    let level = ch.level
    if (which === 'backup' && this.candidate) level = ch.level
    return {
      deviceId: ch.deviceId,
      deviceLabel: ch.deviceLabel,
      status: this.statusOf(which),
      level,
      auditioned: ch.auditioned,
    }
  }

  private micActive(): boolean {
    const tracks: MediaStreamTrackLike[] = []
    if (this.channels.primary.line) tracks.push(...this.channels.primary.line.tracks)
    if (this.channels.backup.line) tracks.push(...this.channels.backup.line.tracks)
    if (this.candidate) tracks.push(...this.candidate.line.tracks)
    // 在途流（已 getUserMedia 成功但还没建成线路）同样占着麦克风。
    for (const pending of this.inflightStreams) tracks.push(...pending.getAudioTracks())
    return tracks.some((t) => t.readyState === 'live')
  }

  private buildSnapshot(): Snapshot {
    // 记录设备选择，供 stop 后保留。
    this.lastPrimaryId = this.channels.primary.deviceId
    this.lastPrimaryLabel = this.channels.primary.deviceLabel
    this.lastBackupId = this.channels.backup.deviceId
    this.lastBackupLabel = this.channels.backup.deviceLabel

    const requesting =
      this.authorizing ||
      this.channels.primary.requesting ||
      this.channels.backup.requesting
    const canArm = this.canArmInternal()
    return {
      phase: this.phase,
      generation: this.generation,
      supported: this.supported,
      capabilityReason: this.capabilityReason,
      message: this.message,
      devices: this.devices,
      primary: this.viewOf('primary'),
      backup: this.viewOf('backup'),
      activeWhich: this.activeWhich,
      micActive: this.micActive(),
      canArm,
      auditionLocked:
        this.phase === 'armed' || this.phase === 'switching' || this.phase === 'live',
      canSwitch: this.phase === 'armed' && !requesting,
      canStop:
        this.phase === 'audition' ||
        this.phase === 'armed' ||
        this.phase === 'switching' ||
        this.phase === 'live' ||
        requesting,
      busy: this.phase === 'switching' || requesting,
    }
  }
}

class ResumeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioContextResumeError'
  }
}
