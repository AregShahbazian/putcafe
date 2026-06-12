export const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const
export type Interval = (typeof INTERVALS)[number]

interface Props {
  selected: Interval
  onSelect: (interval: Interval) => void
}

export default function TimeframeSelector({ selected, onSelect }: Props) {
  return (
    <div className="timeframe-selector">
      {INTERVALS.map(iv => (
        <button
          key={iv}
          className={iv === selected ? "tf-button selected" : "tf-button"}
          onClick={() => onSelect(iv)}
        >
          {iv}
        </button>
      ))}
    </div>
  )
}
