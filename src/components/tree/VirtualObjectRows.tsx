import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useExplorerStore } from '../../stores/explorer'
import { getClient } from '../../api/client'
import type { ObjectInstance } from '../../api/types'
import { TreeNode } from './TreeNode'
import { flattenObjectForest, resolveCompositionFlags, getObjectLabel, ESTIMATED_ROW_HEIGHT } from './treeData'

const TREE_INDENT_PX = 16
const TREE_BASE_PADDING_PX = 8
const TREE_ROW_RIGHT_PADDING_PX = 8
const TREE_CHEVRON_SLOT_PX = 16
const TREE_ICON_SLOT_PX = 20
const TREE_GAP_PX = 8
const TREE_COUNT_EXTRA_PX = 32
const TREE_WIDTH_SAFETY_PX = 32

// ── Virtualized flat Objects list ───────────────────────────────────────────
// The Objects folder can hold tens of thousands of entries, each of which may
// expand into compositional children. Its visible forest is flattened into one
// linear array and windowed, so only rows in (or near) the viewport are mounted
// instead of rendering the whole catalog at once.

export function VirtualObjectRows({
  roots,
  scrollRef,
  contentRef,
  filterText,
}: {
  roots: ObjectInstance[]
  scrollRef: React.RefObject<HTMLDivElement>
  contentRef: React.RefObject<HTMLDivElement>
  filterText: string
}) {
  const expandedNodes = useExplorerStore(s => s.expandedNodes)
  const childObjects = useExplorerStore(s => s.childObjects)
  const compositionCache = useExplorerStore(s => s.compositionCache)

  // Memoized so scroll-driven re-renders (which don't change any of these) reuse
  // the flattened list instead of re-walking the whole forest each frame.
  const rows = useMemo(
    () => flattenObjectForest(roots, expandedNodes, childObjects, compositionCache, filterText),
    [roots, expandedNodes, childObjects, compositionCache, filterText]
  )

  const listRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_HEIGHT)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [listMinWidth, setListMinWidth] = useState(0)

  // Offset of this list within the shared scroll container. It shifts whenever
  // content above it (the Namespaces folder) grows or collapses, so recompute on
  // any size change of the tree body. The +scrollTop term makes it independent
  // of the current scroll position.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current
    const contentEl = contentRef.current
    const listEl = listRef.current
    if (!scrollEl || !contentEl || !listEl) return
    const measure = () => {
      const margin =
        listEl.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop
      setScrollMargin(prev => (Math.abs(prev - margin) > 0.5 ? margin : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(contentEl)
    return () => ro.disconnect()
  }, [scrollRef, contentRef])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    scrollMargin,
    getItemKey: (index) => rows[index].key,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start - scrollMargin : 0
  const paddingBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1].end - scrollMargin)
      : 0

  // The outer tree uses max-content width for horizontal scrolling. Because the
  // virtual list only mounts visible rows, compute a stable width from every
  // flattened row so long offscreen labels can still extend the scrollbar.
  useLayoutEffect(() => {
    if (rows.length === 0) {
      setListMinWidth(0)
      return
    }

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const labelEl = listRef.current?.querySelector('.tree-node .whitespace-nowrap')
    const styleSource = labelEl ?? listRef.current
    if (context && styleSource) {
      const style = window.getComputedStyle(styleSource)
      context.font = style.font || `${style.fontSize} ${style.fontFamily}`
    }
    const measureText = (text: string) => context?.measureText(text).width ?? text.length * 8

    let widest = 0
    for (const row of rows) {
      const leftPadding = row.depth * TREE_INDENT_PX + TREE_BASE_PADDING_PX
      const label = row.kind === 'marker' ? row.message : getObjectLabel(row.obj)
      let width = leftPadding + measureText(label) + TREE_ROW_RIGHT_PADDING_PX + TREE_WIDTH_SAFETY_PX
      if (row.kind === 'object') {
        width += TREE_CHEVRON_SLOT_PX + TREE_ICON_SLOT_PX + TREE_GAP_PX * 2
        if (row.count !== undefined) {
          width += TREE_COUNT_EXTRA_PX + measureText(String(row.count))
        }
      }
      widest = Math.max(widest, Math.ceil(width))
    }
    setListMinWidth(prev => (Math.abs(prev - widest) > 0.5 ? widest : prev))
  }, [rows])

  // Resolve composition chevrons for the rows currently in view so they reflect
  // real child counts instead of the optimistic default — without ever resolving
  // the whole catalog at once. Debounced so it fires once scrolling settles.
  useEffect(() => {
    const client = getClient()
    if (!client) return
    const targets: ObjectInstance[] = []
    for (const vi of virtualItems) {
      const row = rows[vi.index]
      if (row.kind === 'object' && row.obj.isComposition && !compositionCache.has(row.obj.elementId)) {
        targets.push(row.obj)
      }
    }
    if (targets.length === 0) return
    const handle = setTimeout(() => { void resolveCompositionFlags(client, targets) }, 150)
    return () => clearTimeout(handle)
  }, [virtualItems, rows, compositionCache])

  // Measure the true row height once from the first mounted object row so the
  // spacer math matches the DOM regardless of platform/theme (emoji glyph
  // heights differ across OSes).
  const measuredRef = useRef(false)
  const measureFirstRow = useCallback((el: HTMLDivElement | null) => {
    if (!el || measuredRef.current) return
    const h = el.getBoundingClientRect().height
    if (h > 0) {
      measuredRef.current = true
      if (Math.abs(h - rowHeight) > 0.5) setRowHeight(h)
    }
  }, [rowHeight])

  return (
    <div ref={listRef} style={listMinWidth > 0 ? { minWidth: listMinWidth } : undefined}>
      <div style={{ paddingTop, paddingBottom }}>
        {virtualItems.map((vi, i) => {
          const row = rows[vi.index]
          const measure = i === 0 && row.kind === 'object' ? measureFirstRow : undefined
          if (row.kind === 'marker') {
            return (
              <div
                key={row.key}
                style={{ paddingLeft: `${row.depth * 16 + 8}px`, height: rowHeight }}
                className="flex items-center text-i3x-text-muted text-sm"
              >
                {row.message}
              </div>
            )
          }
          return (
            <div key={row.key} ref={measure}>
              <TreeNode
                id={`obj:${row.obj.elementId}`}
                label={getObjectLabel(row.obj)}
                count={row.count}
                type="object"
                data={row.obj}
                depth={row.depth}
                hasChildren={row.hasChildren}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
