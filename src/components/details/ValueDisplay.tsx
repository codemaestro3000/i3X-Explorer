import type { LastKnownValue } from '../../api/types'
import { JsonViewer } from './JsonViewer'

interface ValueDisplayProps {
  value: LastKnownValue
}

// Normative quality enum (1.0): Good | GoodNoData | Bad | Uncertain.
// Non-standard strings fall through to quality-unknown.
function qualityClassFor(quality?: string): string {
  const q = quality?.toLowerCase() ?? ''
  if (q.startsWith('good')) return 'quality-good'
  if (q.startsWith('bad')) return 'quality-bad'
  if (q.startsWith('uncertain')) return 'quality-uncertain'
  return 'quality-unknown'
}

function formatComponentValue(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function ValueDisplay({ value }: ValueDisplayProps) {
  const qualityLabel = value.quality ?? 'Unknown'
  const components = value.components ? Object.entries(value.components) : []

  return (
    <div className="bg-i3x-surface rounded overflow-hidden">
      {/* 1.0: HTTP 206 — a server-imposed limit truncated the composition tree */}
      {value.partialDetail && (
        <div className="px-3 py-1.5 bg-i3x-warning/10 border-b border-i3x-warning/20 text-xs text-i3x-warning">
          ⚠ Partial result: {value.partialDetail}
        </div>
      )}

      {/* Metadata bar */}
      {(value.timestamp || value.quality) && (
        <div className="px-3 py-1.5 bg-i3x-bg/50 border-b border-i3x-border flex items-center gap-4 text-xs">
          {value.timestamp && (
            <span className="text-i3x-text-muted">
              Timestamp: <span className="text-i3x-text">{new Date(value.timestamp).toLocaleString()}</span>
            </span>
          )}
          {value.dataType && (
            <span className="text-i3x-text-muted">
              Type: <span className="text-i3x-text">{value.dataType}</span>
            </span>
          )}
          <span className={qualityClassFor(value.quality)} title={qualityLabel}>● {qualityLabel}</span>
        </div>
      )}

      {/* Value content */}
      <div className="p-3">
        {typeof value.value === 'object' ? (
          <JsonViewer data={value.value} initialExpanded={true} />
        ) : (
          <code className="text-sm text-i3x-text">{String(value.value)}</code>
        )}
      </div>

      {/* Composition child values (1.0: maxDepth > 1 returns VQTs keyed by elementId) */}
      {components.length > 0 && (
        <div className="border-t border-i3x-border">
          <div className="px-3 py-1.5 bg-i3x-bg/50 text-xs font-medium text-i3x-text-muted">
            Components ({components.length})
          </div>
          <div className="divide-y divide-i3x-border">
            {components.map(([childId, vqt]) => (
              <div key={childId} className="px-3 py-1.5 flex items-center gap-3 text-xs">
                <code className="text-i3x-text-muted truncate flex-1 min-w-0" title={childId}>
                  {childId}
                </code>
                <code className="text-i3x-text truncate max-w-[40%]" title={formatComponentValue(vqt.value)}>
                  {formatComponentValue(vqt.value)}
                </code>
                {vqt.quality && (
                  <span className={qualityClassFor(vqt.quality)} title={vqt.quality}>●</span>
                )}
                {vqt.timestamp && (
                  <span className="text-i3x-text-muted whitespace-nowrap">
                    {new Date(vqt.timestamp).toLocaleTimeString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
