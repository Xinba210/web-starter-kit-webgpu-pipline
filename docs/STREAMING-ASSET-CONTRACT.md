# Streamed Asset Contract

## Purpose

This contract defines how production assets enter the camera-centered streaming runtime without forcing whole-world static rebuilds.

The runtime separates three concerns:

- camera demand decides which chunk tier is needed
- streamed scene ownership decides which representation is visible and which geometry belongs to dynamic tracing
- asset manifests decide what files may enter a cleared build

## Chunk representations

Each loaded chunk may provide:

### Active root

The full runtime representation used inside the active camera ring.

Rules:

- tagged as `Mobility.Movable`
- excluded from static lightmap ownership
- included in the dynamic BVH
- eligible for direct shadows
- receives the current runtime lighting path
- membership changes are batched and synchronized once per frame

This classification is intentional even for visually static buildings and terrain pieces. A chunk that can enter or leave at runtime cannot live inside the immutable whole-scene static BVH without rebuilding that structure.

### Proxy root

The low-cost prefetch representation.

Rules:

- visible only in the prefetch tier
- no dynamic GI/BVH participation
- no shadow casting
- `giExclude=true`
- replaced by the Active root when the chunk enters the active ring

The proxy exists to hide asset arrival and preserve distant composition. It is not allowed to consume the same lighting budget as the active representation.

## GI synchronization

`StreamedSceneRuntime` records only meaningful active membership changes.

The render pipeline consumes those changes after scene animation and before dynamic GI update.

When active membership changed:

```
gi.syncDynamicScene(renderer, scene, { materialsChanged })
```

Then normal per-frame rigid motion continues through:

```
gi.updateDynamicScene()
```

The static BVH is not rebuilt when the camera moves or when a streamed chunk enters/leaves.

## Reflection rule

The current cached-reflection implementation captures a concrete dynamic BVH bundle when it is created.

Because streamed membership replaces that bundle, cached reflections are temporarily disabled for streaming hosts. The pipeline falls back to the live reflection path, which reads the current `gi.dynamicBvhBundle` every frame.

A future reflection-cache revision may add source rebinding and invalidation; until then, stale reflection geometry is considered worse than the cheaper live fallback.

## Lightmap and probe rule

Streamed Active roots do not enter the startup static lightmap atlas.

Current fallback:

- direct lighting
- probe lighting
- optional live surfel GI
- dynamic BVH occlusion/reflection participation

Future work will introduce region/chunk-owned baked lighting so static-looking streamed architecture can receive baked quality without merging every chunk into one immutable world atlas.

## Asset manifest

Production files are declared through `StreamedAssetManifest`.

Each asset includes:

- stable asset id
- Active GLB
- optional Proxy GLB
- transform
- provenance

Allowed provenance states:

- `xinba-owned`
- `cleared-commercial`
- `prototype-only`

A normal cleared build rejects `prototype-only`.

A `cleared-commercial` asset must also provide a `licenseRef`.

This is an engineering release gate and does not replace legal review.

## GLB provider

`createGltfChunkProvider()`:

- validates the manifest before use
- uses fetch with `AbortSignal`
- parses GLB through Three.js `GLTFLoader`
- applies manifest transforms
- attaches provenance metadata to loaded roots
- returns Active and Proxy roots to `StreamedSceneRuntime`
- disposes geometry, materials and textures when the package leaves memory

Only GLB is part of this production path. External-resource glTF files should be converted to self-contained GLB during the Blender export pipeline.

## Authoring pipeline

Target production flow:

```
concept / reference
  -> Hunyuan3D or Blender
  -> Blender cleanup, UV, LOD and proxy generation
  -> optional Godot validation
  -> active.glb + proxy.glb
  -> provenance entry
  -> chunk manifest
  -> Three.js streaming runtime
```

The Blender exporter should eventually write the manifest entry automatically.

## Acceptance requirements

A production streaming scene must prove:

- the camera cell receives the Active representation
- look-ahead chunks receive Proxy representation before activation
- Active geometry enters the dynamic BVH after membership changes
- Proxy geometry never enters the dynamic BVH
- leaving the prefetch/unload radius releases scene and GPU resources
- cancelled downloads never attach late geometry
- camera movement does not rebuild the static BVH
- material changes do not leave stale material ids in dynamic tracing
- reflection output never references a retired dynamic BVH

## Next integration

The next asset-side checkpoint is an exporter/importer handshake:

1. generate one Xinba-owned high-detail GLB and one proxy GLB
2. write a real manifest entry
3. stream that pair through the production provider
4. capture Active / Proxy / unload transitions
5. record triangle, memory and dynamic-BVH costs
6. keep the same manifest format for later Blender automation
