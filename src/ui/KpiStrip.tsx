import type { ReactNode } from 'react'

export interface KpiItem {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'neutral' | 'warning' | 'danger' | 'success'
}

interface KpiStripProps {
  items: KpiItem[]
  dense?: boolean
}

export function KpiStrip({ items, dense = false }: KpiStripProps) {
  return (
    <div className={`kpi-strip ${dense ? 'kpi-strip--dense' : ''}`}>
      {items.map((item) => (
        <div className={`kpi-card kpi-${item.tone ?? 'neutral'}`} key={item.label}>
          <span className="kpi-label">{item.label}</span>
          <strong className="kpi-value">{item.value}</strong>
          {item.hint && <span className="kpi-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  )
}
