---
name: ue-engine-mount
description: Tells container agents where the Unreal Engine source tree is mounted inside the container, so they can grep and read engine headers to verify API signatures and class hierarchies.
axis: environment
---

# UE Engine Mount

The Unreal Engine 5.7 source tree is mounted read-only inside the container at:

    /engine

This is the same content as `<UE install>/Engine` on the host. Use it whenever you need to verify a UE API, check a class hierarchy, find a function signature, or look up usage examples — `Read`, `Glob`, and `Grep` all work against `/engine` exactly as they do against `/workspace`.

Common entry points:

- `/engine/Source/Runtime/` — runtime modules (Core, CoreUObject, Engine, etc.)
- `/engine/Source/Editor/` — editor-only modules
- `/engine/Source/Developer/` — developer tooling
- `/engine/Plugins/` — engine-bundled plugins

Do not attempt to write to `/engine` — the mount is read-only and any modification attempt will fail.
