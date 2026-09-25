import { engine, useSnapshot } from './state/useEngine'
import { ChannelCard } from './components/ChannelCard'

const PHASE_TEXT: Record<string, string> = {
  unsupported: '浏览器能力不足',
  idle: '待命',
  audition: '试听中',
  armed: '主路已武装',
  switching: '切换中（80ms 交叉）',
  live: '备用线路播出中',
  fault: '故障',
}

export default function App() {
  const s = useSnapshot()

  if (!s.supported) {
    return (
      <main className="page" data-testid="unsupported">
        <h1>主备话筒切换校验台</h1>
        <p className="error" role="alert" data-testid="capability-reason">
          {s.capabilityReason}
        </p>
        <p className="hint">
          请使用桌面版 Chrome / Edge / Firefox，并通过 https 或 localhost 打开本页。
        </p>
      </main>
    )
  }

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>主备话筒切换校验台</h1>
          <p className="subtitle">同声传译彩排 · 纯前端离线 · 无任何网络接口</p>
        </div>
        <div className={`mic-indicator ${s.micActive ? 'on' : ''}`} data-testid="mic-indicator">
          <i className="dot" />
          {s.micActive ? '麦克风占用中' : '麦克风已释放'}
        </div>
      </header>

      <section className="console">
        <div className="console-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={s.busy || s.auditionLocked}
            onClick={() => void engine.authorize()}
            data-testid="btn-authorize"
          >
            1. 授权麦克风
          </button>
          <span className="phase" data-testid="phase">
            阶段：{PHASE_TEXT[s.phase] ?? s.phase}
          </span>
          <span className="gen" data-testid="generation">
            代次 #{s.generation}
          </span>
        </div>

        <p
          className={`message ${s.phase === 'fault' ? 'error' : ''}`}
          role="status"
          aria-live="polite"
          data-testid="message"
        >
          {s.message || '请先授权麦克风，然后分别为主路、备路选择输入设备并试听。'}
        </p>

        <div className="cards">
          <ChannelCard
            which="primary"
            title="主路"
            channel={s.primary}
            snapshot={s}
            devices={s.devices}
            onSelect={(id) => engine.selectDevice('primary', id)}
            onAudition={() => void engine.audition('primary')}
          />
          <ChannelCard
            which="backup"
            title="备路"
            channel={s.backup}
            snapshot={s}
            devices={s.devices}
            onSelect={(id) => engine.selectDevice('backup', id)}
            onAudition={() => void engine.audition('backup')}
          />
        </div>

        <div className="console-row switch-row">
          <button
            type="button"
            className="btn"
            disabled={!s.canArm}
            onClick={() => engine.arm()}
            title={s.canArm ? '' : '需主、备两路都完成试听且在线'}
            data-testid="btn-arm"
          >
            2. 武装主路
          </button>
          <button
            type="button"
            className="btn btn-warn"
            disabled={!s.canSwitch}
            onClick={() => void engine.switchToBackup()}
            data-testid="btn-switch"
          >
            3. 切换到备路
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!s.canStop}
            onClick={() => engine.stop()}
            data-testid="btn-stop"
          >
            停止并释放全部
          </button>
        </div>

        <ul className="rules" data-testid="rules">
          <li>武装期间禁止另开试听；备用就绪前主路持续输出。</li>
          <li>候选就绪后以 80ms 线性增减益交叉，完成后才停止旧主轨道。</li>
          <li>候选拒绝 / 提前结束 / 音频上下文恢复失败：保留原主路。</li>
          <li>活动主路结束即进入故障态，须重新试听主、备后方可再次武装。</li>
          <li>停止会断开全部节点并关闭音频上下文，不残留麦克风占用。</li>
        </ul>
      </section>
    </main>
  )
}
