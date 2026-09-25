import type { ChannelView, MediaDeviceInfoLike, Snapshot, Which } from '../domain/types'
import { LevelMeter } from './LevelMeter'
import { StatusPill } from './StatusPill'

interface Props {
  which: Which
  title: string
  channel: ChannelView
  snapshot: Snapshot
  devices: MediaDeviceInfoLike[]
  onSelect: (deviceId: string) => void
  onAudition: () => void
}

export function ChannelCard({
  which,
  title,
  channel,
  snapshot,
  devices,
  onSelect,
  onAudition,
}: Props) {
  const disabled = snapshot.auditionLocked || snapshot.busy
  const isActive = snapshot.activeWhich === which
  return (
    <section className={`card ${isActive ? 'card-active' : ''}`} data-testid={`card-${which}`}>
      <header className="card-head">
        <h2>{title}</h2>
        <StatusPill status={channel.status} />
        {isActive && <span className="onair" data-testid={`onair-${which}`}>● 耳返输出中</span>}
      </header>

      <label className="field">
        <span>输入设备</span>
        <select
          value={channel.deviceId}
          disabled={disabled || devices.length === 0}
          onChange={(e) => onSelect(e.target.value)}
          data-testid={`select-${which}`}
        >
          {devices.length === 0 && <option value="">（授权后列出设备）</option>}
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${d.kind} ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>实时电平</span>
        <LevelMeter level={channel.level} />
      </div>

      <div className="card-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || !channel.deviceId || channel.status === 'requesting'}
          onClick={onAudition}
          data-testid={`btn-audition-${which}`}
        >
          {channel.status === 'requesting' ? '取流中…' : `试听${title}`}
        </button>
        <span className="hint" data-testid={`auditioned-${which}`}>
          {channel.auditioned ? '已完成试听' : '尚未试听'}
        </span>
      </div>
    </section>
  )
}
