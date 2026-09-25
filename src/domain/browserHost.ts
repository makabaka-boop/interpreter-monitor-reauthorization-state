import type {
  AudioContextLike,
  Host,
  MediaDeviceInfoLike,
  MediaDevicesLike,
  MediaStreamLike,
} from './types'

/** 真实浏览器宿主：全部来自 navigator/window，不提供任何假实现。 */
export class BrowserHost implements Host {
  mediaDevices(): MediaDevicesLike | null {
    const nav = globalThis.navigator as Navigator | undefined
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      return null
    }
    // enumerateDevices 必须存在，否则无法呈现设备选择。
    if (typeof nav.mediaDevices.enumerateDevices !== 'function') {
      return null
    }
    return nav.mediaDevices as unknown as MediaDevicesLike
  }

  isSecureContext(): boolean {
    return globalThis.isSecureContext !== false
  }

  AudioContextCtor(): (new () => AudioContextLike) | null {
    const w = globalThis as unknown as {
      AudioContext?: new () => AudioContextLike
      webkitAudioContext?: new () => AudioContextLike
    }
    return w.AudioContext ?? w.webkitAudioContext ?? null
  }

  newAudioContext(): AudioContextLike | null {
    const Ctor = this.AudioContextCtor()
    if (!Ctor) return null
    return new Ctor()
  }
}

/**
 * 能力与授权错误的中文原因。
 * 注意：已工作的线路不会被清空，错误只更新 message（且必须是当前代次）。
 */
export function describeCapabilityError(reason:
  | 'insecure'
  | 'no-media-devices'
  | 'no-audio-context'
  | string): string {
  switch (reason) {
    case 'insecure':
      return '当前不是安全上下文（需 https 或 localhost），浏览器禁止麦克风访问。'
    case 'no-media-devices':
      return '浏览器未提供 MediaDevices / getUserMedia，无法进行任何麦克风校验。'
    case 'no-audio-context':
      return '浏览器不支持 AudioContext，无法建立电平与交叉淡化节点。'
    default:
      return reason
  }
}

/** 把 getUserMedia 的 DOMException 名称 / Error 映射为可读原因。 */
export function describeMediaError(error: unknown): string {
  const e = error as { name?: string; message?: string } | undefined
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return '麦克风授权被拒绝。请在浏览器地址栏允许麦克风后重试。'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return '所选输入设备不存在或已拔出，请重新选择设备。'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被其他程序占用或硬件无法启动。'
    case 'AbortError':
      return '取流被中止，请重试。'
    case 'AudioContextResumeError':
      return '音频上下文恢复失败（AudioContext resume 被拒绝）。'
    default:
      return e?.message ? `取流失败：${e.message}` : '取流失败：未知错误。'
  }
}

export function devicesMatch(
  list: MediaDeviceInfoLike[],
  deviceId: string,
): MediaDeviceInfoLike | undefined {
  return list.find((d) => d.deviceId === deviceId && d.deviceId !== '')
}

export function streamHasLiveAudio(stream: MediaStreamLike): boolean {
  return stream.getAudioTracks().some((t) => t.readyState === 'live')
}
