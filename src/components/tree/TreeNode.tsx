import { useCallback } from 'react'
import { useExplorerStore, type SelectedItem } from '../../stores/explorer'
import { getClient } from '../../api/client'
import type { Namespace, ObjectType, ObjectInstance } from '../../api/types'
import {
  resolveCompositionFlags,
  refreshAllObjects,
  OBJECTS_FOLDER_ID,
  HIERARCHICAL_FOLDER_ID,
} from './treeData'

// Icons
const FolderIcon = () => (
  <span style={{ filter: 'sepia(1) saturate(1.6) hue-rotate(-15deg) brightness(0.89)' }}>🗄️</span>
)
// 📁 emoji renders grey on some macOS configurations; sepia/saturate filter
// forces a manilla tint while keeping the emoji aesthetic of the rest of the
// tree.
const FolderTypeIcon = () => (
  <span style={{ filter: 'sepia(1) saturate(2) hue-rotate(-5deg) brightness(1.05)' }}>📁</span>
)

// Three lowest-common-denominator buckets for object instances that aren't
// FolderType. Driven by OPC UA's nodeClass when available (carried through on
// metadata.system.nodeClass), with a typeId/sourceTypeId keyword fallback.
const ObjectClassIcon = () => <span>📦</span>
const VariableClassIcon = () => <span>📊</span>

const SCALAR_TYPES = new Set(['number', 'integer', 'string', 'boolean'])

// Per the i3X Implementation Guide: schema.type is the sole authoritative leaf signal.
// scalar type (number/integer/string/boolean) → leaf (📊); everything else → branch (📦).
// schema.type may be a union array (e.g. ["number","null"]) — treat as leaf if any member is scalar.
function bucketInstance(
  obj: ObjectInstance | undefined,
  typeIndex?: Map<string, ObjectType>
): 'variable' | 'other' {
  if (!obj) return 'other'
  const raw = typeIndex?.get(obj.typeId)?.schema?.type
  const schemaType = Array.isArray(raw)
    ? (raw as string[]).find(t => SCALAR_TYPES.has(t)) ?? ''
    : String(raw ?? '')
  return SCALAR_TYPES.has(schemaType) ? 'variable' : 'other'
}
const NamespaceIcon = () => <span className="text-i3x-primary">🌐</span>
const TypeIcon = () => <span className="text-i3x-success">📃</span>
const ChevronRight = () => <span className="text-i3x-text-muted">›</span>
const ChevronDown = () => <span className="text-i3x-text-muted">⌄</span>

interface TreeNodeProps {
  id: string
  label: string
  type: 'namespace' | 'objectType' | 'object' | 'folder'
  data?: Namespace | ObjectType | ObjectInstance
  depth: number
  hasChildren?: boolean
  // Optional minimalist count badge rendered to the right of the label —
  // small, muted, no brackets. Only rendered when defined.
  count?: number
  children?: React.ReactNode
}

export function TreeNode({ id, label, type, data, depth, hasChildren, count, children }: TreeNodeProps) {
  // Narrow selectors: a node re-renders only when its own expanded/selected
  // state changes, not on every unrelated store update (live subscription
  // values, cache merges, etc.). typeIndex is the shared map built once in the
  // store, so nodes no longer each rebuild a Map over all object types.
  const isExpanded = useExplorerStore(s => s.expandedNodes.has(id))
  const isSelected = useExplorerStore(s => s.selectedItem?.id === id)
  const typeIndex = useExplorerStore(s => s.typeIndex)

  const handleClick = useCallback(async () => {
    // Store actions are stable references; pull them at call time so they don't
    // need to be selector subscriptions or effect/callback dependencies.
    const { toggleNode, selectItem, setObjects, setHierarchicalRoots, setChildObjects, mergeCompositionFlags } = useExplorerStore.getState()
    // Select the item
    if (data && type !== 'folder') {
      selectItem({ type, id, data } as SelectedItem)
    }

    // Toggle expansion
    if (hasChildren) {
      toggleNode(id)

      // Re-fetch objects for this type whenever expanding (always fresh)
      if (type === 'objectType' && !isExpanded) {
        const client = getClient()
        if (client) {
          try {
            const objectType = data as ObjectType
            const objects = await client.getObjects(objectType.elementId)
            await resolveCompositionFlags(client, objects)
            setObjects(objectType.elementId, objects)
          } catch (err) {
            console.error('Failed to load objects:', err)
          }
        }
      }

      // Re-fetch all objects whenever expanding Objects or Hierarchy folder.
      // Opening a folder forces a fresh fetch (bypasses the navigation throttle).
      if ((id === OBJECTS_FOLDER_ID || id === HIERARCHICAL_FOLDER_ID) && !isExpanded) {
        const client = getClient()
        if (client) {
          try {
            await refreshAllObjects(client, true)
          } catch (err) {
            console.error('Failed to load all objects:', err)
          }
        }
      }

      // For the Hierarchy folder, also fetch root objects via root=true so the server
      // determines what counts as a root (avoids relying on parentId === '/' locally)
      if (id === HIERARCHICAL_FOLDER_ID && !isExpanded) {
        const client = getClient()
        if (client) {
          try {
            const roots = await client.getObjects(undefined, false, true)
            await resolveCompositionFlags(client, roots)
            setHierarchicalRoots(roots)
          } catch (err) {
            console.error('Failed to load root objects:', err)
          }
        }
      }

      // Re-fetch all objects when expanding a hierarchy node to pick up newly
      // discovered objects. Throttled/coalesced so rapidly expanding many nodes
      // doesn't trigger a full 58k-object refetch per click on large catalogs.
      if (id.startsWith('hier:') && !isExpanded) {
        const client = getClient()
        if (client) {
          try {
            await refreshAllObjects(client)
          } catch (err) {
            console.error('Failed to refresh objects for hierarchy node:', err)
          }
        }
      }

      // Re-fetch child objects whenever expanding a compositional object (always fresh)
      if (type === 'object' && !isExpanded && !id.startsWith('hier:')) {
        const obj = data as ObjectInstance
        if (obj.isComposition) {
          const client = getClient()
          if (client) {
            try {
              const related = await client.getRelatedObjects(obj.elementId, 'HasComponent')
              const compositionalChildren = related.filter(child =>
                child.isComposition &&
                child.elementId !== obj.elementId &&
                child.parentId === obj.elementId
              )
              await resolveCompositionFlags(client, compositionalChildren)
              setChildObjects(obj.elementId, compositionalChildren)
              // Reflect the real qualifying-child count on the parent so an
              // optimistic chevron self-corrects to "no chevron" when a click
              // reveals there is nothing to expand.
              mergeCompositionFlags([[obj.elementId, compositionalChildren.length]])
            } catch (err) {
              console.error('Failed to load child objects:', err)
            }
          }
        }
      }
    }
  }, [data, type, id, hasChildren, isExpanded])

  const getIcon = () => {
    switch (type) {
      case 'namespace':
        return <NamespaceIcon />
      case 'objectType': {
        // ObjectType definitions whose source resolves to OPC UA FolderType
        // render as a folder.
        const t = data as ObjectType | undefined
        const src = (t?.sourceTypeId ?? '').toLowerCase()
        const id = (t?.elementId ?? '').toLowerCase()
        if (src.includes('foldertype') || id.includes('foldertype')) return <FolderTypeIcon />
        return <TypeIcon />
      }
      case 'object': {
        const obj = data as ObjectInstance | undefined
        // FolderType instances always render as a folder.
        const typeId = (obj?.typeId ?? '').toLowerCase()
        const metaSrc = String(obj?.metadata?.sourceTypeId ?? '').toLowerCase()
        if (typeId.includes('foldertype') || metaSrc.includes('foldertype')) {
          return <FolderTypeIcon />
        }
        // Otherwise bucket into one of three lowest-common-denominator classes.
        switch (bucketInstance(obj, typeIndex)) {
          case 'variable': return <VariableClassIcon />
          default: return <ObjectClassIcon />
        }
      }
      case 'folder':
        return <FolderIcon />
    }
  }

  return (
    <div>
      <div
        className={`tree-node ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {hasChildren && (
          <span className="w-4 flex-shrink-0">
            {isExpanded ? <ChevronDown /> : <ChevronRight />}
          </span>
        )}
        {!hasChildren && <span className="w-4" />}
        <span className="flex-shrink-0">{getIcon()}</span>
        <span className="whitespace-nowrap text-sm">{label}</span>
        {/* All counts render on the right edge of the row. Leader line is
            solid when the row is expanded (the count is "active"), dashed
            otherwise. */}
        {count !== undefined && (
          <>
            <div
              className={`flex-1 self-center mx-2 h-0 border-t ${
                isExpanded
                  ? 'border-solid border-i3x-text-muted/40'
                  : 'border-dashed border-i3x-text-muted/25'
              }`}
            />
            <span className="pr-2 text-sm text-i3x-text-muted/60 tabular-nums flex-shrink-0">
              {count}
            </span>
          </>
        )}
      </div>
      {isExpanded && children}
    </div>
  )
}
