export function LevelMeter({ level }: { level: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100)
  return (
    <div
      className="meter"
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      data-level={pct}
    >
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}
