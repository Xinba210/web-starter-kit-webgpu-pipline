# Copyright and License Audit

## Current verdict

This fork is safe to continue using as a research, prototyping and engineering reference repository, but it should not yet be treated as a cleared commercial distribution base.

The upstream repository is:

- `vibegameengine/web-starter-kit-webgpu-pipline`

The fork is:

- `Xinba210/web-starter-kit-webgpu-pipline`

As checked on 2026-10-06, neither the upstream root nor the fork root contains:

- `LICENSE`
- `LICENSE.md`
- `COPYING`
- a root `README.md` containing an explicit software license

GitHub repository metadata also does not identify a license.

## What that means

A public GitHub repository being forkable does not by itself grant a general open-source license to reuse, redistribute, sublicense or commercially publish the code outside the rights supplied by GitHub's service functionality.

Do not add MIT, Apache-2.0 or another license to the whole fork unless the upstream copyright holder grants rights that permit doing so.

## Risk classification

### High risk until cleared

- inherited source files from the upstream repository
- inherited shader code
- inherited rendering pipeline implementations
- inherited procedural asset generators
- inherited bundled image, HDRI, texture, GLB and other binary assets whose provenance is not separately documented

### Lower risk but still tracked

Code written after the Xinba fork was created can have independent authorship, but a new file that imports, copies, adapts or substantially follows protected upstream implementation can still be part of a derivative work.

The first Xinba-specific additions currently include:

- view-weighted lightmap residency changes
- camera-centered chunk streaming code
- Xinba rendering roadmap and diagnostics

These should be migrated into a clean repository if commercial clearance of the upstream code cannot be obtained.

### Asset notes

`src/entities/village/assets/README.md` documents several village albedo/foliage textures as AI-generated outputs, which gives materially better provenance than undocumented binaries.

That same file also says `limestone-normal.jpg` was copied from an existing project texture. That source texture, and other existing bundled textures/HDRIs/models, require a separate provenance and license audit before commercial release.

## Recommended commercial-safe path

### Path A — get explicit upstream permission

Ask the upstream copyright owner to add a recognized license or provide written permission covering:

- commercial use
- modification
- redistribution
- derivative works
- bundled shader/source distribution
- whether attribution is required

This is the fastest path if permission is available.

### Path B — clean-room Xinba renderer

If permission is unavailable, retain the repository only as a technical research reference and rebuild the production renderer in a new Xinba-owned repository.

Clean-room rules:

1. Write a behavior/specification document describing observable requirements and algorithms at a high level.
2. Do not copy inherited source text, shader expressions, comments, identifiers or file structure verbatim.
3. Implement the specification independently.
4. Use Three.js/WebGPU public APIs and independently researched papers/documentation.
5. Replace every inherited texture, HDRI, model and binary with:
   - Xinba-generated content, or
   - assets carrying an explicit compatible commercial license.
6. Keep a provenance ledger for every production asset and external dependency.
7. Preserve evidence of independently authored source commits and design documents.

## Architectural consequence

All new Xinba systems should be written behind narrow interfaces so they can be moved out of this fork later without dragging inherited implementation with them.

Priority separation boundaries:

- world chunk streaming
- view importance scoring
- asset manifest
- geometry LOD/HLOD policy
- texture residency policy
- dynamic update governor
- render diagnostics

These modules should depend on Three.js contracts rather than private inherited renderer internals wherever practical.

## Runtime provenance gate

The streaming runtime now requires production assets to declare provenance in `StreamedAssetManifest`.

Recognized clearance states:

- `xinba-owned`
- `cleared-commercial`
- `prototype-only`

A cleared build rejects `prototype-only` assets by default. Externally licensed `cleared-commercial` assets must carry a `licenseRef`.

This does not turn an uncleared asset into a cleared one; it prevents an already-known prototype/uncleared asset from silently entering the production streaming path.

## Release gate

Do not ship a paid game, publish this renderer as Xinba-owned open source, or sublicense the full fork until one of these is true:

1. upstream grants an adequate license/permission; or
2. all inherited protected implementation and uncleared assets required by the shipped product have been independently replaced.

This file is an engineering risk record, not legal advice.
