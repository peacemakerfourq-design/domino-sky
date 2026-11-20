import { Pause, Play, RotateCcw } from 'lucide-react'
import { formatTime } from './format'

interface ReplayControlsProps {
  time: number
  playing: boolean
  onTimeChange: (time: number) => void
  onPlayingChange: (playing: boolean) => void
  onReset: () => void
}

export function ReplayControls({
  time,
  playing,
  onTimeChange,
  onPlayingChange,
  onReset,
}: ReplayControlsProps) {
  return (
    <div className="replay-controls">
      <button
        className="replay-play"
        onClick={() => onPlayingChange(!playing)}
        aria-label={playing ? 'Pause cascade replay' : 'Play cascade replay'}
      >
        {playing ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <button className="icon-button" onClick={onReset} aria-label="Reset replay">
        <RotateCcw size={16} />
      </button>
      <div className="scrubber-wrap">
        <input
          type="range"
          min="0"
          max="1440"
          step="5"
          value={time}
          onChange={(event) => onTimeChange(Number(event.target.value))}
          aria-label="Cascade replay time"
        />
        <div className="scrubber-ticks" aria-hidden="true">
          <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
        </div>
      </div>
      <output className="replay-time">{formatTime(time)}</output>
    </div>
  )
}
