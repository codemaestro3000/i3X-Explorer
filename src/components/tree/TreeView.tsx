import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useExplorerStore } from '../../stores/explorer'
import { useConnectionStore } from '../../stores/connection'
import { getClient } from '../../api/client'
import type { ObjectType, ObjectInstance } from '../../api/types'
import { TreeNode } from './TreeNode'
import { VirtualObjectRows } from './VirtualObjectRows'
import {
  resolveCompositionFlags,
  resolveOnDemandChildren,
  refreshAllObjects,
  hasCompositionChildren,
  getObjectLabel,
  MAX_TREE_DEPTH,
  NAMESPACES_FOLDER_ID,
  OBJECTS_FOLDER_ID,
  HIERARCHICAL_FOLDER_ID,
} from './treeData'

const BACKGROUND_POLL_ENABLED = true

// Recursive component for rendering objects with their children
function ObjectNode({
  obj,
  depth,
  filterText,
  ancestors = new Set<string>()
}: {
  obj: ObjectInstance
  depth: number
  filterText: string
  ancestors?: Set<string>
}) {
  // Subscribe only to this object's children, not the entire map
  const children = useExplorerStore(
    (state) => state.childObjects.get(obj.elementId) ?? []
  )
  const compositionCache = useExplorerStore((state) => state.compositionCache)
  const filteredChildren = children.filter(
    (child) =>
      !filterText ||
      child.displayName.toLowerCase().includes(filterText) ||
      child.elementId.toLowerCase().includes(filterText) ||
      child.namespaceUri.toLowerCase().includes(filterText)
  )

  // Prevent infinite recursion - depth limit or cycle detection
  if (depth > MAX_TREE_DEPTH || ancestors.has(obj.elementId)) {
    return (
      <div style={{ paddingLeft: `${depth * 16 + 8}px` }} className="text-i3x-text-muted text-sm">
        {ancestors.has(obj.elementId) ? '(cycle detected)' : '(max depth reached)'}
      </div>
    )
  }

  // Add current object to ancestors for children
  const childAncestors = new Set(ancestors)
  childAncestors.add(obj.elementId)

  // Count: prefer the loaded children array (post-expansion); fall back to the
  // resolver-populated cache for unexpanded compositional objects.
  const cachedCount = compositionCache.get(obj.elementId)
  const childCount = children.length > 0 ? children.length : cachedCount
  return (
    <TreeNode
      id={`obj:${obj.elementId}`}
      label={getObjectLabel(obj)}
      count={childCount && childCount > 0 ? childCount : undefined}
      type="object"
      data={obj}
      depth={depth}
      hasChildren={hasCompositionChildren(obj, compositionCache)}
    >
      {filteredChildren.map((child) => (
        <ObjectNode
          key={child.elementId}
          obj={child}
          depth={depth + 1}
          filterText={filterText}
          ancestors={childAncestors}
        />
      ))}
    </TreeNode>
  )
}

// Recursive component for hierarchical (parent/child) view
// This uses parentId relationships from allObjects rather than API calls
function HierarchicalObjectNode({
  obj,
  depth,
  filterText,
  childrenByParent,
  visibleIds,
  ancestors = new Set<string>()
}: {
  obj: ObjectInstance
  depth: number
  filterText: string
  childrenByParent: Map<string, ObjectInstance[]>
  // When filterText is active, set of object IDs that should remain visible
  // (matches + their ancestors). Computed once at the TreeView level.
  visibleIds?: Set<string>
  ancestors?: Set<string>
}) {
  // On-demand HasChildren served via /objects/related but absent from the flat
  // /objects list; fetched on expand and merged with the prebuilt parentId
  // index below. onDemandResolved lets the optimistic hierarchy chevron settle
  // once the server confirms whether this node has hidden children.
  const onDemand = useExplorerStore(s => s.onDemandChildren.get(obj.elementId))
  const onDemandResolved = useExplorerStore(s => s.onDemandResolved.has(obj.elementId))

  // Direct children via the prebuilt parentId index (O(1) lookup instead of
  // scanning the entire allObjects array on every node), with any on-demand
  // children merged in after them.
  const parentIdChildren = childrenByParent.get(obj.elementId) ?? []
  const parentIdChildIds = new Set(parentIdChildren.map(child => child.elementId))
  const onDemandOnly = onDemand?.filter(child => !parentIdChildIds.has(child.elementId)) ?? []
  const children = onDemandOnly.length > 0
    ? [...parentIdChildren, ...onDemandOnly]
    : parentIdChildren
  const filteredChildren = filterText
    ? children.filter(child => visibleIds?.has(child.elementId))
    : children

  // Prevent infinite recursion - depth limit or cycle detection
  if (depth > MAX_TREE_DEPTH || ancestors.has(obj.elementId)) {
    return (
      <div style={{ paddingLeft: `${depth * 16 + 8}px` }} className="text-i3x-text-muted text-sm">
        {ancestors.has(obj.elementId) ? '(cycle detected)' : '(max depth reached)'}
      </div>
    )
  }

  // Add current object to ancestors for children
  const childAncestors = new Set(ancestors)
  childAncestors.add(obj.elementId)

  // Chevron: real children, or an unresolved hierarchy node that may have
  // on-demand HasChildren fetched only when expanded.
  const hasChildren = children.length > 0 || !onDemandResolved

  return (
    <TreeNode
      id={`hier:${obj.elementId}`}
      label={getObjectLabel(obj)}
      count={children.length > 0 ? children.length : undefined}
      type="object"
      data={obj}
      depth={depth}
      hasChildren={hasChildren}
    >
      {filteredChildren.map((child) => (
        <HierarchicalObjectNode
          key={child.elementId}
          obj={child}
          depth={depth + 1}
          filterText={filterText}
          childrenByParent={childrenByParent}
          visibleIds={visibleIds}
          ancestors={childAncestors}
        />
      ))}
    </TreeNode>
  )
}

export function TreeView() {
  // Narrow selectors so the tree re-renders only for the slices it uses, not on
  // every unrelated store update (e.g. live subscription values).
  const namespaces = useExplorerStore(s => s.namespaces)
  const objectTypes = useExplorerStore(s => s.objectTypes)
  const objects = useExplorerStore(s => s.objects)
  const allObjects = useExplorerStore(s => s.allObjects)
  const hierarchicalRoots = useExplorerStore(s => s.hierarchicalRoots)
  const childrenByParent = useExplorerStore(s => s.childrenByParent)
  const onDemandChildren = useExplorerStore(s => s.onDemandChildren)
  const searchQuery = useExplorerStore(s => s.searchQuery)
  const setSearchQuery = useExplorerStore(s => s.setSearchQuery)
  const pollIntervalMs = useExplorerStore(s => s.pollIntervalMs)
  const manualRefreshTick = useExplorerStore(s => s.manualRefreshTick)
  // Only the flat Objects folder needs to know its own expansion state here, so
  // its (potentially huge) child list is filtered/built only while it is open.
  const objectsExpanded = useExplorerStore(s => s.expandedNodes.has(OBJECTS_FOLDER_ID))
  const isConnected = useConnectionStore(state => state.isConnected)

  // Shared scroll container + content wrapper, referenced by the virtualized
  // Objects list to window its rows and track its offset within the scroll area.
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const refreshTree = useCallback(async () => {
    const client = getClient()
    if (!client) return

    const { expandedNodes, setNamespaces, setObjectTypes, setObjects, setHierarchicalRoots, setChildObjects } = useExplorerStore.getState()

    try {
      const [namespaces, objectTypes] = await Promise.all([
        client.getNamespaces(),
        client.getObjectTypes()
      ])
      setNamespaces(namespaces)
      setObjectTypes(objectTypes)
    } catch (err) {
      console.error('Background refresh: namespaces/types failed', err)
    }

    let allObjectsRefreshed = false
    const refreshedChildIds = new Set<string>()

    for (const nodeId of expandedNodes) {
      if (nodeId.startsWith('type:')) {
        const typeElementId = nodeId.slice(5)
        try {
          const objects = await client.getObjects(typeElementId)
          await resolveCompositionFlags(client, objects)
          setObjects(typeElementId, objects)
        } catch (err) {
          console.error('Background refresh: type failed', typeElementId, err)
        }
      }

      if ((nodeId === OBJECTS_FOLDER_ID || nodeId === HIERARCHICAL_FOLDER_ID) && !allObjectsRefreshed) {
        allObjectsRefreshed = true
        try {
          await refreshAllObjects(client, true)
        } catch (err) {
          console.error('Background refresh: all objects failed', err)
        }
      }

      if (nodeId === HIERARCHICAL_FOLDER_ID) {
        try {
          const roots = await client.getObjects(undefined, false, true)
          await resolveCompositionFlags(client, roots)
          setHierarchicalRoots(roots)
        } catch (err) {
          console.error('Background refresh: root objects failed', err)
        }
      }

      if (nodeId.startsWith('obj:') || nodeId.startsWith('hier:')) {
        const elementId = nodeId.startsWith('obj:') ? nodeId.slice(4) : nodeId.slice(5)
        if (!refreshedChildIds.has(elementId)) {
          refreshedChildIds.add(elementId)
          try {
            const related = await client.getRelatedObjects(elementId, 'HasComponent')
            const compositionalChildren = related.filter(child =>
              child.isComposition &&
              child.elementId !== elementId &&
              child.parentId === elementId
            )
            await resolveCompositionFlags(client, compositionalChildren)
            setChildObjects(elementId, compositionalChildren)
          } catch (err) {
            console.error('Background refresh: children failed', elementId, err)
          }
        }
      }

      // Keep on-demand children fresh for expanded hierarchy branches, mirroring
      // the compositional refresh above.
      if (nodeId.startsWith('hier:')) {
        await resolveOnDemandChildren(client, nodeId.slice(5))
      }
    }
  }, [])

  // Background poll on configured interval (0 = disabled)
  useEffect(() => {
    if (!isConnected || !BACKGROUND_POLL_ENABLED || pollIntervalMs === 0) return
    const intervalId = setInterval(refreshTree, pollIntervalMs)
    return () => clearInterval(intervalId)
  }, [isConnected, pollIntervalMs, refreshTree])

  // Manual refresh trigger
  useEffect(() => {
    if (!isConnected || manualRefreshTick === 0) return
    refreshTree()
  }, [manualRefreshTick, isConnected, refreshTree])

  // Auto-expand the three root folders whenever a search query is active so
  // matches are visible without the user having to click each folder open.
  useEffect(() => {
    if (!searchQuery.trim()) return
    const { expandNode } = useExplorerStore.getState()
    expandNode(NAMESPACES_FOLDER_ID)
    expandNode(OBJECTS_FOLDER_ID)
    expandNode(HIERARCHICAL_FOLDER_ID)
  }, [searchQuery])

   // Filter based on search. To make deep matches surface their ancestors,
   // we precompute three sets:
   //   matchingTypeIds: type IDs that have ≥1 matching object (so the type and
   //     its parent namespace stay visible even if their own names don't match)
   //   hierarchyVisibleIds: object IDs to keep in the Hierarchy view —
   //     every match plus every ancestor up the parentId chain
   //   matchedNamespaceUris: namespace URIs reached transitively via matching
   //     types/objects (so a namespace whose name doesn't match still renders
   //     when something inside it does)
   const filterText = searchQuery.toLowerCase()
   const objMatches = (obj: ObjectInstance) =>
     obj.displayName.toLowerCase().includes(filterText) ||
     obj.elementId.toLowerCase().includes(filterText) ||
     obj.namespaceUri.toLowerCase().includes(filterText)

  const matchingTypeIds = new Set<string>()
  const hierarchyVisibleIds = new Set<string>()
  const matchedNamespaceUris = new Set<string>()
  if (filterText) {
    const objById = new Map(allObjects.map(o => [o.elementId, o]))
    for (const root of hierarchicalRoots) objById.set(root.elementId, root)
    for (const children of onDemandChildren.values()) {
      for (const child of children) objById.set(child.elementId, child)
    }
    for (const obj of objById.values()) {
      if (!objMatches(obj)) continue
      matchingTypeIds.add(obj.typeId)
      // Walk parents up to the root, marking every ancestor visible
      let cur: ObjectInstance | undefined = obj
      while (cur && !hierarchyVisibleIds.has(cur.elementId)) {
        hierarchyVisibleIds.add(cur.elementId)
        cur = cur.parentId ? objById.get(cur.parentId) : undefined
      }
    }
    // Any type that matches by name OR by descendant pulls its namespace in
    for (const type of objectTypes) {
      const typeMatches =
        type.displayName.toLowerCase().includes(filterText) ||
        type.elementId.toLowerCase().includes(filterText) ||
        matchingTypeIds.has(type.elementId)
      if (typeMatches) matchedNamespaceUris.add(type.namespaceUri)
    }
  }

  const filteredNamespaces = namespaces.filter(ns => {
    if (!filterText) return true
    if (
      ns.displayName.toLowerCase().includes(filterText) ||
      ns.uri.toLowerCase().includes(filterText)
    ) return true
    return matchedNamespaceUris.has(ns.uri)
  })

  // Group object types by namespace; keep types whose name matches OR whose
  // descendant objects match.
  const typesByNamespace = new Map<string, ObjectType[]>()
  objectTypes.forEach((type) => {
    const keep =
      !filterText ||
      type.displayName.toLowerCase().includes(filterText) ||
      type.elementId.toLowerCase().includes(filterText) ||
      matchingTypeIds.has(type.elementId)
    if (keep) {
      const types = typesByNamespace.get(type.namespaceUri) || []
      types.push(type)
      typesByNamespace.set(type.namespaceUri, types)
    }
  })

  // Filter all objects for the Objects folder (flat list — only direct matches).
  // Materialized only while the Objects folder is open: with tens of thousands
  // of objects, filtering and building this array on every render is a large
  // cost that would otherwise be paid even while the folder is collapsed.
  const filteredAllObjects = useMemo(() => {
    if (!objectsExpanded) return [] as ObjectInstance[]
    if (!filterText) return allObjects
    return allObjects.filter(obj =>
      obj.displayName.toLowerCase().includes(filterText) ||
      obj.elementId.toLowerCase().includes(filterText) ||
      obj.namespaceUri.toLowerCase().includes(filterText)
    )
  }, [objectsExpanded, filterText, allObjects])

  const filteredHierarchicalRoots = hierarchicalRoots.filter(
    obj => !filterText || hierarchyVisibleIds.has(obj.elementId)
  )

  const hasNamespaces = namespaces.length > 0

  // Instance count per type, derived from already-loaded allObjects (no extra
  // network). Memoized so the group-by only runs when allObjects changes, not
  // on every keystroke in the filter input. Hierarchy node counts are derived
  // locally from each node's `children` array, so no parent map needed here.
  const objectCountByType = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of allObjects) m.set(o.typeId, (m.get(o.typeId) ?? 0) + 1)
    return m
  }, [allObjects])

  return (
    <div className="flex flex-col h-full min-h-0 text-i3x-text">
      {/* Filter input — fixed header so it stays put (and full-width) while the
          tree body scrolls horizontally */}
      <div className="shrink-0 bg-i3x-surface pb-2 mb-1">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Filter tree…"
          className="w-full px-2 py-1 text-sm bg-i3x-bg border border-i3x-border rounded text-i3x-text placeholder:text-i3x-text-muted focus:outline-none focus:border-i3x-primary"
        />
      </div>

      {/* Tree body — scrolls both axes. The inner w-max wrapper grows to the
          widest row so long labels/deep nesting extend a horizontal scrollbar,
          while min-w-full keeps rows (highlights, count leader-lines) panel-wide
          when content fits. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
       <div ref={contentRef} className="w-max min-w-full">
      {/* Namespaces folder */}
      <TreeNode
        id={NAMESPACES_FOLDER_ID}
        label="Namespaces"
        count={namespaces.length > 0 ? namespaces.length : undefined}
        type="folder"
        depth={0}
        hasChildren={hasNamespaces}
      >
        {filteredNamespaces.map((namespace) => {
          const nsTypes = typesByNamespace.get(namespace.uri) || []
          const hasTypes = nsTypes.length > 0

          return (
            <TreeNode
              key={namespace.uri}
              id={`ns:${namespace.uri}`}
              label={namespace.displayName}
              count={nsTypes.length > 0 ? nsTypes.length : undefined}
              type="namespace"
              data={namespace}
              depth={1}
              hasChildren={hasTypes}
            >
               {nsTypes.map((type) => {
                 const typeObjects = objects.get(type.elementId) ?? []
                 const filteredObjects = typeObjects.filter(
                   (obj) =>
                     !filterText ||
                     obj.displayName.toLowerCase().includes(filterText) ||
                     obj.elementId.toLowerCase().includes(filterText) ||
                     obj.namespaceUri.toLowerCase().includes(filterText)
                 )
                 const instanceCount = objectCountByType.get(type.elementId)

                 return (
                   <TreeNode
                     key={type.elementId}
                     id={`type:${type.elementId}`}
                     label={type.displayName}
                     count={instanceCount && instanceCount > 0 ? instanceCount : undefined}
                     type="objectType"
                     data={type}
                     depth={2}
                     hasChildren={true}
                   >
                     {filteredObjects.map((obj) => (
                       <ObjectNode
                         key={obj.elementId}
                         obj={obj}
                         depth={3}
                         filterText={filterText}
                       />
                     ))}
                   </TreeNode>
                 )
               })}
            </TreeNode>
           )
         })}
       </TreeNode>

       {/* Objects folder (flat list) */}
       <TreeNode
         id={OBJECTS_FOLDER_ID}
         label="Objects"
         count={allObjects.length > 0 ? allObjects.length : undefined}
         type="folder"
         depth={0}
         hasChildren={true}
       >
         <VirtualObjectRows
           roots={filteredAllObjects}
           scrollRef={scrollRef}
           contentRef={contentRef}
           filterText={filterText}
         />
         {allObjects.length > 0 && filteredAllObjects.length === 0 && (
           <div className="text-i3x-text-muted text-sm py-2 pl-8">
             No matching objects
           </div>
         )}
       </TreeNode>

      {/* Hierarchical folder (parent/child structure) */}
      <TreeNode
        id={HIERARCHICAL_FOLDER_ID}
        label="Hierarchy"
        count={hierarchicalRoots.length > 0 ? hierarchicalRoots.length : undefined}
        type="folder"
        depth={0}
        hasChildren={true}
      >
        {filteredHierarchicalRoots.map((obj) => (
          <HierarchicalObjectNode
            key={`hier-${obj.elementId}`}
            obj={obj}
            depth={1}
            filterText={filterText}
            childrenByParent={childrenByParent}
            visibleIds={hierarchyVisibleIds}
          />
        ))}
        {allObjects.length > 0 && filteredHierarchicalRoots.length === 0 && (
          <div className="text-i3x-text-muted text-sm py-2 pl-8">
            {filterText ? 'No matching objects' : 'No root objects found'}
          </div>
        )}
      </TreeNode>

      {!hasNamespaces && (
        <div className="text-center text-i3x-text-muted text-sm py-4">
          {searchQuery ? 'No results found' : 'Connect to a server to browse'}
        </div>
      )}
       </div>
      </div>
    </div>
  )
}
