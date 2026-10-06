# Xinba AAA WebGPU Render Pipeline Roadmap

## 1. Goal

Turn this fork into a reusable Three.js/WebGPU rendering core for Xinba game projects.

The target is **console-class visual presentation with web-appropriate runtime cost**, not console-class asset weight. The visible camera view receives the highest fidelity. Off-screen and low-impact content should consume progressively less geometry, lightmap, simulation and update budget.

Primary runtime:
- Three.js r182 + WebGPU
- TSL/WGSL
- Existing FrameGraph
- Existing baked lightmap atlas + live surfel GI
- Existing probe volumes, reflections, atmosphere, clouds, TAA and post stack

Production tools may generate assets outside the runtime:
- Blender
- Godot
- Hunyuan3D
- Python / Node utilities

Final game rendering stays in Three.js.

## 2. Existing baseline that must be preserved

This repository already contains a mature rendering stack and should not be rewritten from zero:

- WebGPU FrameGraph and G-buffer
- static/dynamic mobility split
- baked lightmap atlas
- live surfel GI for movable receivers
- probe volume fallback
- lightmap chart pyramids and resident tile pool
- screen-derived lightmap demand feedback
- TAA / FXAA
- motion blur
- volumetric fog
- physical sky and clouds
- reflection tracing / reflection cache
- water, foliage and terrain material work
- leak, LOD and render diagnostics

All new work should extend these systems instead of creating parallel renderers.

## 3. Runtime quality law

### 3.1 Visible-first quality

The camera drives quality allocation.

Priority order:
1. large visible surfaces near the camera
2. large visible surfaces farther away
3. small visible surfaces
4. peripheral and transitional content
5. off-screen content

Off-screen geometry may still exist for gameplay, physics, shadows or prediction, but it should not receive the same rendering/simulation budget as the visible view.

### 3.2 Static and dynamic lighting remain split

Static world:
- bake once
- stream required lightmap detail
- do not rebake because the camera moved

Movable world:
- live surfels / probes / dynamic light
- update only the receivers that need it
- keep rigid ownership stable

### 3.3 Graceful degradation

When a budget is exhausted, quality must degrade by hierarchy rather than fail:
- fine lightmap tile -> parent tile -> chart tail
- high geometry LOD -> lower LOD -> impostor / cluster proxy
- full simulation -> reduced cadence -> sleep
- expensive reflection -> cached / probe fallback

No visible surface should become black or invalid merely because a high-detail page is missing.

## 4. Architecture to build toward

### A. Asset production

```
Image references / concept art
  -> Hunyuan3D or Blender generation
  -> Blender cleanup / UV / LOD / rig / export
  -> optional Godot validation tools
  -> GLB + compressed textures + metadata
  -> Three.js runtime
```

Each exported scene object should eventually carry metadata such as:
- mobility
- bounds
- LOD group
- stream group
- material class
- lightmap eligibility
- gameplay persistence id

### B. World streaming

The world will be partitioned into stream cells/chunks.

Each chunk has at least:
- gameplay state
- proxy representation
- render representation
- lighting data
- collision/nav representation
- persistence key

The camera activates a high-fidelity region and a larger prefetch region. Player movement must never require loading the entire world at maximum quality.

### C. Geometry quality

Planned:
- camera/frustum-aware chunk loading
- distance + projected-screen-size LOD
- directional prefetch
- instancing for repeated foliage/props
- occlusion-aware update suppression
- geometry memory budget
- mesh/texture release hysteresis

### D. Lighting quality

Existing lightmap LOD becomes the first production-quality streaming layer.

Planned:
- view-weighted lightmap residency
- multi-page on-demand transport
- static lightmap persistence by scene/chunk
- dynamic receiver GI budget
- probe fallback for objects without charts
- cached reflection volumes per region

### E. Material / texture quality

Planned:
- view-dependent texture resolution
- texture arrays / atlas policy
- compressed GPU formats
- material feature tiers
- terrain virtual-texture style layering
- shared material registry to reduce pipeline churn

### F. Simulation quality

Planned update classes:
- Critical: player, nearby combat, visible interactive object
- Active: visible NPC/VFX/physics
- Reduced: nearby but not visible
- Sleep: far/off-screen persistent state only

The render budget and gameplay correctness budget are separate. Sleeping render work must not delete gameplay state.

## 5. Implementation phases

### P0 — Fork stabilization
Status: active

- keep `main` stable
- use `develop` for integration
- preserve inherited renderer behavior
- expose diagnostics for every new streaming decision

### P1 — View-weighted lightmap streaming
Status: implemented in first checkpoint

Problem in inherited code:
- demand already came from pixels actually drawn by the camera
- but the demand was reduced to a Set
- tile residency therefore lost information about how much of the screen each tile occupied
- under copy-budget or pool-capacity pressure, a tiny visible tile could compete equally with a dominant foreground tile

Implementation:
- `DemandFeedback` counts sampled screen fragments per lightmap tile
- weights travel through `LightmapLod` and `TilePool`
- `TileResidency` coarsens low-impact demand first
- within the same mip level, upload order favors higher screen impact
- parent weights accumulate when children are coarsened
- `__lod()` exposes feedback tile count, max demand weight and upload KiB
- unit tests cover copy-budget and capacity-pressure priority

Acceptance:
- foreground/high-coverage tiles become resident before low-coverage peers
- low-impact tiles fall back to parent/tail instead of stealing scarce slots
- old callers without weights retain valid behavior

### P2 — Camera-centered world chunk streamer
Status: production geometry/GI ownership foundation implemented

Implemented:
- reusable `CameraChunkStreamer`
- active and prefetch rings
- direction-aware look-ahead
- unload hysteresis
- per-update load/unload budgets
- obsolete async-load cancellation
- deterministic chunk coordinates and ids
- `StreamedSceneRuntime` Active/Proxy ownership
- Active chunks synchronized through the dynamic BVH without rebuilding the static BVH
- Proxy chunks excluded from GI and shadows
- one membership synchronization per frame after chunk changes
- safe live-reflection fallback while cached reflections cannot rebind dynamic BVH sources
- provenance-aware `StreamedAssetManifest`
- cancellable GLB provider with Active/Proxy loading and GPU resource disposal
- controlled `lod-scale?chunks=1` visualization with `__chunks` / `__streaming` diagnostics
- unit coverage for look-ahead, budget priority, hysteresis, cancellation, scene ownership and provenance gates

Build toward:
- camera cell
- high-fidelity ring
- prefetch ring
- direction-aware look-ahead
- load/unload hysteresis
- async cancellation
- memory budgets
- deterministic chunk ids

Acceptance:
- moving across a large scene never requires all chunks at full quality
- returning to a visited chunk restores the same deterministic world state
- no visible pop caused by immediate unload at a boundary

### P3 — Geometry LOD and instancing contract

- projected-size LOD selection
- object LOD metadata
- HLOD/cluster proxies for distant architecture
- foliage instancing and wind tiers
- static batching rules
- visibility-driven update cadence

### P4 — Texture/material streaming

- per-material texture tier
- compressed runtime formats
- residency budget
- terrain layer streaming
- shader feature reduction for low-impact objects

### P5 — Dynamic scene quality governor

- visible combat/VFX at full cadence
- off-screen animation throttling
- dynamic GI admission tied to receiver impact
- reflection update cadence tied to camera impact
- particle/VFX intensity budget without changing gameplay hit logic

### P6 — Production game integration

Connect exported Blender/Godot/Hunyuan3D content to a common scene manifest:
- models
- collisions
- spawn points
- lightmap groups
- reflection volumes
- LOD groups
- persistence ids
- interaction metadata

## 6. Validation gates

Every checkpoint must provide at least one direct observable hook or test.

Required categories:
- correctness: no missing/black lighting fallback
- stability: no page thrash at camera boundaries
- memory: bounded resident geometry/textures/lightmaps
- CPU: no whole-world traversal per frame where a spatial index can replace it
- GPU: no hidden duplicate render path
- visual: fresh headed frame inspection when a runnable browser environment is available

Do not claim Unreal-equivalent quality from a unit test. Visual quality is accepted only from actual rendered frames.

## 7. Branch policy

- `main`: stable baseline
- `develop`: ongoing integration
- feature branches only when parallel work genuinely requires them

Do not push experimental renderer rewrites directly to `main`.

## 8. NEXT_MANDATORY

Build the **Pinned Fallback Physical Pool** for chunk-owned XVLM lighting, then connect visible-fragment demand to fine XVLM tile uploads.

The production asset handshake now has a committed Xinba-owned engineering fixture: Active GLB + Proxy GLB + manifest + XVLM + browser/non-browser acceptance gates. It deliberately does not claim final art quality. The first Blender/Hunyuan3D-authored high-quality asset remains mandatory once the authorized Windows tool device is available.

After physical fallback/fine-tile residency, move to projected-screen-size geometry LOD/HLOD and texture/material streaming.

Commercialization must follow `docs/COPYRIGHT-AND-LICENSE-AUDIT.md`; new Xinba-owned modules stay separable from inherited upstream implementation.
