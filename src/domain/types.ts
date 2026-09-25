/**
 * 校验台领域模型。
 *
 * 关键不变量：
 *  - 每次“试听 / 武装 / 切换 / 停止 / 故障”都递增 generation（代次）；
 *    异步操作返回时仅当代次仍然匹配才可接管线路，否则其流必须立即停止。
 *  - 候选拒绝、候选提前结束、AudioContext 恢复失败时，原主路继续输出。
 *  - 活动主路（武装后的主路、切换后的备路）一旦 ended 即进入 fault，
 *    必须重新试听主、备之后才允许再次武装。
 */

export type Which = 'primary' | 'backup'

export type Phase =
  | 'unsupported'
  | 'idle' // 已授权，可选择设备 / 试听
  | 'audition' // 至少一路试听在线
  | 'armed' // 主路已武装为活动线路，禁止另开试听
  | 'switching' // 80ms 交叉淡化进行中
  | 'live' // 切换完成，备路活动输出
  | 'fault' // 活动主路结束或切换中候选夭折；需重新试听

/** 单路轨道对界面呈现的状态。 */
export type TrackStatus =
  | 'idle' // 无轨道
  | 'requesting' // getUserMedia 进行中（本路代次）
  | 'live' // 轨道工作中
  | 'stopping' // 正在停止 / 淡化收尾
  | 'ended' // 轨道自然结束（历史终态展示）
  | 'released' // 已停止并释放节点

export interface ChannelView {
  deviceId: string
  deviceLabel: string
  status: TrackStatus
  /** 0..1 实时电平，由 AnalyserNode 轮询得到。 */
  level: number
  /** 该路是否至少完成过一次试听（武装的前置条件）。 */
  auditioned: boolean
}

export interface Snapshot {
  phase: Phase
  generation: number
  supported: boolean
  /** 浏览器能力缺失等硬错误（MediaDevices 不存在、非安全上下文…）。 */
  capabilityReason: string
  /** 最近一次失败 / 提示信息；较早代次的失败不得改写它。 */
  message: string
  /** getUserMedia 授权后枚举到的全部音频输入设备。 */
  devices: MediaDeviceInfoLike[]
  primary: ChannelView
  backup: ChannelView
  /** 当前正在输出的活动线路归属：null 表示没有活动输出。 */
  activeWhich: Which | null
  /** 是否仍有任何 MediaStreamTrack 处于 live（浏览器麦克风占用指示）。 */
  micActive: boolean
  /** 武装按钮可用性：两路都试听成功且当前没有进行中的代次。 */
  canArm: boolean
  /** 武装期间禁止另开试听。 */
  auditionLocked: boolean
  canSwitch: boolean
  canStop: boolean
  busy: boolean
}

export interface MediaDeviceInfoLike {
  deviceId: string
  label: string
  kind: string
}

/** 一条音频线路：流 + 轨道结束侦听 + 图节点。 */
export interface Line {
  stream: MediaStreamLike
  tracks: MediaStreamTrackLike[]
  source: AudioNodeLike
  gain: GainNodeLike
  analyser: AnalyserNodeLike
  /** 切换时备监听线路被静音但仍占着图，用得到这个引用。 */
  muted: boolean
  released: boolean
}

export interface MediaStreamTrackLike {
  readonly kind: string
  readonly label: string
  readonly readyState: 'live' | 'ended'
  stop(): void
  getSettings(): MediaTrackSettingsLike
  addEventListener(type: string, listener: EventListenerLike): void
  removeEventListener(type: string, listener: EventListenerLike): void
}

export interface MediaTrackSettingsLike {
  deviceId?: string
}

export interface EventListenerLike {
  (event: unknown): void
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[]
  getAudioTracks(): MediaStreamTrackLike[]
}

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number
  getByteTimeDomainData(array: Uint8Array): void
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown
  disconnect(): void
}

export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike
}

export interface AudioParamLike {
  value: number
  setValueAtTime(value: number, time: number): void
  linearRampToValueAtTime(value: number, time: number): void
  /** 撤销已排定的自动参数（交叉淡化中候选夭折时恢复主路输出）。 */
  cancelScheduledValues(time: number): void
}

export interface AudioContextLike {
  readonly currentTime: number
  readonly state: 'suspended' | 'running' | 'closed'
  destination: AudioNodeLike
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike
  createGain(): GainNodeLike
  createAnalyser(): AnalyserNodeLike
  resume(): Promise<void>
  close(): Promise<void>
}

/**
 * 宿主能力面：生产代码用 BrowserHost（真实浏览器，禁止假接口），
 * 测试注入 src/testing/fakes.ts 中的可控替身。
 */
export interface Host {
  mediaDevices(): MediaDevicesLike | null
  AudioContextCtor(): (new () => AudioContextLike) | null
  isSecureContext(): boolean
  newAudioContext(): AudioContextLike | null
}

export interface MediaDevicesLike {
  enumerateDevices(): Promise<MediaDeviceInfoLike[]>
  getUserMedia(constraints: MediaStreamConstraintsLike): Promise<MediaStreamLike>
}

export interface MediaStreamConstraintsLike {
  audio?: boolean | { deviceId?: { exact: string } }
}

export const CROSSFADE_MS = 80
