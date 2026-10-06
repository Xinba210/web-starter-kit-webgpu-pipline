# Chunk-Owned Virtual Lightmap Architecture

## Goal

Give streamed architecture baked-lighting quality without rebuilding one world-sized static BVH or keeping one world-sized lightmap atlas resident.

The renderer keeps one bounded physical lightmap pool. Chunks contribute and remove virtual chart/tile metadata as they enter and leave the active region.

## Rejected design: one lightmap texture per chunk

Do not bind a separate sampled lightmap texture to every streamed chunk.

Reasons:

- active chunk count grows with view distance
- material variants multiply
- WebGPU sampled-texture limits become the world-size limit
- reflection/G-buffer/material pipelines would need chunk-specific binding layouts
- the current renderer already hit the sampled-texture ceiling when one additional tail texture was added

The production path keeps one lightmap sampling contract.

## Runtime model

```
Chunk package
  local charts
  local tile hierarchy
  coarsest guaranteed fallback
  fine tile payloads
        |
        v
Global chart namespace
        |
        v
Global page table
        |
        v
Bounded physical tile pool
        |
        v
One TSL lightmap sampler
```

## Chart namespace

Every authored chunk owns local chart ids starting at zero.

When a chunk becomes Active:

1. allocate a contiguous range from `ChartNamespace`
2. remap local `lightmapChart` attributes into that global range
3. register the chunk's chart records in the global page table
4. make the coarsest fallback resident
5. enable baked-light reception only after fallback is valid

When the chunk leaves Active:

1. stop new demand
2. release fine physical tiles
3. unregister chart records
4. release the global chart range
5. fall back to probe lighting / Proxy representation

A returning chunk may receive a different global base. Local chart ids are retained separately so remapping is repeatable.

## Tile ownership

The physical pool remains globally bounded.

A resident tile key must identify:

- chunk generation
- global chart slot
- mip level
- tile x/y

A stale request from a retired chunk generation must never be allowed to populate a slot now owned by a new chunk.

## Fallback law

No Active lightmapped surface may become black because a fine page is missing.

Fallback order:

```
requested fine tile
  -> nearest resident parent
  -> chunk coarsest tile/tail
  -> probe lighting while chunk lighting is not ready
```

The existing chart-tail rule remains the quality model. The world-streaming version changes where that tail is stored and when it is resident.

## Tile source contract

`TilePool` no longer owns the assumption that all tile pixels were created during startup.

`LightmapTileSource` is the transport boundary.

Current source:

- `MemoryLightmapTileSource`

Next source:

- chunk package source backed by an asynchronously loaded binary payload

The TSL sampler, physical pool and residency policy do not change when the source changes.

## Chunk lighting states

```
UNLOADED
  -> INDEX_LOADING
  -> FALLBACK_LOADING
  -> READY
  -> ACTIVE
  -> DRAINING
  -> UNLOADED
```

### INDEX_LOADING

Load only metadata required to understand charts and tile offsets.

### FALLBACK_LOADING

Load the coarsest guaranteed representation first.

The Active mesh may be visible with probe lighting while this state is incomplete, but it is not marked as a baked-light receiver.

### READY

Chart records and fallback are valid. Baked-light reception may switch on.

### ACTIVE

Fine tile demand is generated from actual visible fragments. View-weighted residency decides which fine pages receive bandwidth and slots.

### DRAINING

No new requests. Outstanding generation-tagged requests may complete but must be discarded rather than installed. Physical slots and chart allocation are released.

## Package format direction

The chunk lightmap payload will use a versioned binary container, provisionally `XVLM`.

Required index fields:

- magic + version
- authored chunk id
- lighting revision
- tile size / border
- chart count
- metres per texel
- chart rectangles
- mip/tile offsets
- coarsest fallback offsets
- per-tile byte offset / byte length
- payload digest

Payload tiles are GPU-ready half-float RGBA unless a later compression experiment proves a better transport format.

The binary format is intentionally separate from the scene-wide authoring bake bundle in `persistedBake.ts`. The authoring bundle contains surfel/probe state that is not appropriate to ship per runtime chunk.

## Probe relationship

Proxy and not-yet-ready Active chunks use probes.

When chunk baked lighting becomes READY:

- charted surfaces receive baked light
- uncharted surfaces continue to receive probes/live GI
- dynamic actors continue to use probes/live GI
- the chunk does not become part of the immutable startup static BVH

## Reflection relationship

Reflection capture must see the current Active geometry.

Until cached reflection sources can rebind after dynamic membership changes, streaming hosts use the live reflection path. A later cache revision should invalidate only volumes influenced by the changed chunk.

## Already implemented

- camera-centered chunk demand
- Active / Proxy / Unload scene ownership
- dynamic-BVH membership synchronization
- static BVH revision diagnostics
- provenance-aware GLB manifest
- committed Xinba-owned Active/Proxy GLB fixture
- headed Active/Proxy/Unload/Return acceptance script
- `LightmapTileSource` abstraction
- `MemoryLightmapTileSource`
- reusable `ChartNamespace`
- repeatable local-to-global `lightmapChart` remapping
- fixed-capacity `WorldLightmapRegistry`
- generation-tagged chart/tile ownership
- stale-handle rejection after range reuse
- zero fine-tile cost for tail-only chunks
- strict chart/tile/parent hierarchy validation
- `ChunkLightingRuntime` async activation lifecycle
- XVLM package cancellation, identity validation and registry rollback
- versioned `XVLM` encoder/decoder with SHA-256 integrity
- committed tail-only XVLM transport fixture
- chunk lighting metadata in `StreamedAssetManifest`
- `__streaming` lighting residency diagnostics

## NEXT_MANDATORY

Implement the **Pinned Fallback Physical Pool**.

It must:

1. reserve physical fallback capacity before a chunk is marked baked-light ready
2. upload each active chart's coarsest guaranteed representation into bounded GPU storage
3. never evict a fallback while its chart is active
4. allow fine tiles to compete only for the remaining physical slots
5. reject stale generation-tagged uploads after chunk retirement
6. release every pinned slot when the chunk demotes to Proxy or unloads
7. expose pinned/fine slot counts and uploaded KiB through `__streaming`
8. preserve the existing scene-global `LightmapLod` path unchanged

After the fallback pool is live, connect visible-fragment demand to XVLM fine-tile uploads and then replace the engineering fixture with the first Blender/Hunyuan3D-authored production-quality asset.
