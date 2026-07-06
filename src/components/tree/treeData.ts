import type { I3XClient } from '../../api/client'
import { useExplorerStore } from '../../stores/explorer'
import type { ObjectInstance } from '../../api/types'

// Special folder IDs
export const NAMESPACES_FOLDER_ID = 'folder:namespaces'
export const OBJECTS_FOLDER_ID = 'folder:objects'
export const HIERARCHICAL_FOLDER_ID = 'folder:hierarchical'

// Max depth for tree rendering to prevent infinite loops
export const MAX_TREE_DEPTH = 20

// Fallback row height until the real one is measured from the first mounted row.
export const ESTIMATED_ROW_HEIGHT = 28

// Resolve chevron state for a set of compositional parents by asking the server
// what /objects/related actually returns — i.e. the same data the render filter
// sees at expansion time. Single batch round trip; only unresolved isComposition
// objects are queried, so callers can pass a superset cheaply.
export async function resolveCompositionFlags(client: I3XClient, loaded: ObjectInstance[]): Promise<void> {
  if (loaded.length === 0) return
  const { compositionCache, mergeCompositionFlags } = useExplorerStore.getState()
  const toResolve: string[] = []
  for (const obj of loaded) {
    if (obj.isComposition && !compositionCache.has(obj.elementId)) {
      toResolve.push(obj.elementId)
    }
  }
  if (toResolve.length === 0) return
  const additions = new Map<string, number>()
  try {
    const related = await client.getRelatedObjectsBatch(toResolve, 'HasComponent')
    for (const parentId of toResolve) {
      const children = related.get(parentId) ?? []
      const qualifyingCount = children.filter(c =>
        c.isComposition && c.elementId !== parentId && c.parentId === parentId
      ).length
      additions.set(parentId, qualifyingCount)
    }
  } catch (err) {
    console.error('Failed to resolve composition flags via /objects/related:', err)
  }
  if (additions.size > 0) mergeCompositionFlags(additions)
}

// Fetch a hierarchy node's on-demand HasChildren — children a source serves via
// /objects/related but deliberately absent from the flat /objects list — and
// store the ones not already indexed under this parent. Mirrors
// resolveCompositionFlags, but for HasChildren hierarchy edges rather than
// HasComponent composition edges.
export async function resolveOnDemandChildren(client: I3XClient, elementId: string): Promise<void> {
  const { childrenByParent, setOnDemandChildren } = useExplorerStore.getState()
  const existing = new Set((childrenByParent.get(elementId) ?? []).map(c => c.elementId))
  try {
    const related = await client.getRelatedObjects(elementId, 'HasChildren')
    const onDemand = related.filter(c => c.parentId === elementId && !existing.has(c.elementId))
    setOnDemandChildren(elementId, onDemand)
  } catch (err) {
    console.error('Failed to resolve on-demand children via /objects/related:', err)
  }
}

// Coalesce + throttle full "all objects" refetches. Expanding a hierarchy node
// refetches the entire object set to surface dynamically-discovered objects
// (e.g. MQTT topics arriving over time). On large catalogs that full refetch is
// expensive, so rapid navigation shares one in-flight request and skips
// refetches that ran within a short window. Folder opens and the periodic
// background poll pass force=true, so freshness is still guaranteed.
//
// Composition chevrons are resolved lazily for the visible window (see
// VirtualObjectRows), never for the whole catalog here — a single batch over
// tens of thousands of objects is slow and can fail, leaving chevrons wrong.
const ALL_OBJECTS_REFETCH_TTL_MS = 3000
let allObjectsFetchedAt = 0
let allObjectsInFlight: Promise<void> | null = null

export async function refreshAllObjects(client: I3XClient, force = false): Promise<void> {
  if (allObjectsInFlight) return allObjectsInFlight
  if (!force && Date.now() - allObjectsFetchedAt < ALL_OBJECTS_REFETCH_TTL_MS) return
  allObjectsInFlight = (async () => {
    try {
      const objects = await client.getObjects()
      useExplorerStore.getState().setAllObjects(objects)
      allObjectsFetchedAt = Date.now()
    } finally {
      allObjectsInFlight = null
    }
  })()
  return allObjectsInFlight
}

// Chevron predicate: consult the compositionCache, which holds the actual child
// count resolved via batched /objects/related. If we haven't resolved this
// object yet, fall back to its isComposition flag (chevron may show momentarily
// until the resolver lands).
export function hasCompositionChildren(obj: ObjectInstance, cache: Map<string, number>): boolean {
  if (!obj.isComposition) return false
  const cached = cache.get(obj.elementId)
  return cached === undefined ? true : cached > 0
}

// Get display label for an object, handling special cases like root "/"
export function getObjectLabel(obj: ObjectInstance): string {
  if (obj.displayName && obj.displayName.trim()) {
    return obj.displayName
  }
  // Fallback to elementId for objects with empty displayName (e.g., root "/")
  return obj.elementId
}

// ── Flattened Objects forest ────────────────────────────────────────────────
// The Objects folder can hold tens of thousands of entries, each of which may
// expand into compositional children. Its visible forest is flattened into one
// linear array so it can be windowed (see VirtualObjectRows).

export interface FlatObjectRow {
  kind: 'object'
  key: string
  obj: ObjectInstance
  depth: number
  hasChildren: boolean
  count?: number
}
export interface FlatMarkerRow {
  kind: 'marker'
  key: string
  depth: number
  message: string
}
export type FlatRow = FlatObjectRow | FlatMarkerRow

// Produce the ordered, visible rows of the Objects forest, mirroring the
// expansion, filter, and cycle/depth guards that ObjectNode applies when it
// renders recursively.
export function flattenObjectForest(
  roots: ObjectInstance[],
  expandedNodes: Set<string>,
  childObjects: Map<string, ObjectInstance[]>,
  compositionCache: Map<string, number>,
  filterText: string
): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (obj: ObjectInstance, depth: number, ancestors: Set<string>, path: string) => {
    const key = `${path}/${obj.elementId}`
    if (depth > MAX_TREE_DEPTH || ancestors.has(obj.elementId)) {
      rows.push({
        kind: 'marker',
        key: `${key}#stop`,
        depth,
        message: ancestors.has(obj.elementId) ? '(cycle detected)' : '(max depth reached)',
      })
      return
    }
    const children = childObjects.get(obj.elementId) ?? []
    const cachedCount = compositionCache.get(obj.elementId)
    const childCount = children.length > 0 ? children.length : cachedCount
    rows.push({
      kind: 'object',
      key,
      obj,
      depth,
      hasChildren: hasCompositionChildren(obj, compositionCache),
      count: childCount && childCount > 0 ? childCount : undefined,
    })
    if (!expandedNodes.has(`obj:${obj.elementId}`)) return
    const childAncestors = new Set(ancestors)
    childAncestors.add(obj.elementId)
    for (const child of children) {
      if (
        filterText &&
        !child.displayName.toLowerCase().includes(filterText) &&
        !child.elementId.toLowerCase().includes(filterText) &&
        !child.namespaceUri.toLowerCase().includes(filterText)
      ) continue
      walk(child, depth + 1, childAncestors, key)
    }
  }
  for (const obj of roots) walk(obj, 1, new Set<string>(), 'all')
  return rows
}
