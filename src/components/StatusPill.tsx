import type { TrackStatus } from '../domain/types'

const TEXT: Record<TrackStatus, string> = {
  idle: '空闲',
  requesting: '取流中…',
  live: '在线',
  stopping: '淡化收尾…',
  ended: '已结束',
  released: '已释放',
}

export function StatusPill({ status }: { status: TrackStatus }) {
  return (
    <span className={`pill pill-${status}`} data-status={status}>
      <i className="dot" />
      {TEXT[status]}
    </span>
  )
}
