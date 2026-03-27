# Architecture Vision: Distributed Asset Platform

**Status:** Strategic intent. Informs design decisions in current work; full implementation is post-launch.

**Core Insight:** The Supabase + git + blob storage + remote ops infrastructure enables a **Perforce alternative** — a distributed, open-source game asset management system with zero seat licensing.

---

## The Problem Perforce Solves (Today)

Perforce (P4) centralizes:
- Large binary assets (meshes, textures, animations, sounds)
- Asset versioning and history
- Team collaboration (who's working on what)
- Integrity checks (file sizes, checksums, dependencies)
- Distributed team coordination (expensive seat licenses)

**Cost:** Per-seat licensing model. Expensive for large teams. Proprietary.

---

## The Architecture We're Building

**Three-Layer System:**

### Layer 1: Code (Git)
- Source of truth for **code + small metadata**
- Team pushes/pulls normally
- Fast, efficient, proven

### Layer 2: Content Catalogue (Supabase)
- Relational database for **asset metadata** (names, versions, checksums, dependencies, ownership)
- **Audit log** of all asset changes (who, what, when)
- **Dependency graph** (which assets are used in which scenes, builds, levels)
- **Lock protocol** (asset checkout/check-in, preventing conflicts)
- **Quota tracking** (bandwidth, storage, asset count)
- **Search + discovery** (find assets by type, tags, status, owner)

### Layer 3: Binary Storage (Blob)
- Vercel Blob, AWS S3, GCS, or self-hosted
- **Large asset files** (textures, meshes, animations, sounds)
- Reference from Supabase via checksum/path
- Integrity verified at upload/download
- Optional compression, delta encoding, content-addressed storage

### Layer 4: Coordination (Current Remote Ops)
- Fastify polling loop + admin queue (already designed)
- Routes asset operations (upload, download, validate, merge)
- Coordinates distributed team (agents, humans, build systems)
- Manages UBT mutex + build scheduling

---

## How It Works: The Workflow

### Asset Upload Flow
```
Developer (remote)
  → Insert "upload_asset" command in Supabase admin queue
    ↓
Fastify polling loop picks up command
  → Validates: asset metadata in catalogue? Quota OK? Checksum matches?
    ↓ (if valid)
  → Accept asset file → blob storage
  → Update Supabase: mark asset as "active", record checksum, version
  → Agents/build system can now fetch this asset
```

### Asset Checkout (Lock) Flow
```
Agent starting work on UE level that uses TextureA_v2
  → Query Supabase: "lock TextureA_v2 for editing"
    ↓
Supabase checks: is TextureA_v2 already locked? By whom? For how long?
  → If free: grant lock, record owner + timestamp
  → If locked: return error + owner info (conflict detection)
    ↓
Agent fetches asset from blob storage (using checksum from Supabase)
Agent edits locally
  → Agent pushes new version (TextureA_v3)
    ↓
Update Supabase: increment version, update checksum, release lock
  → Notify team: "TextureA updated, new version available"
```

### Build Pipeline Integration
```
Build system (via admin queue)
  → Request: "compile level with assets from version 5.2.1"
    ↓
Fastify fetches asset manifest from Supabase (which assets, which versions)
  → Downloads each asset from blob storage (cached locally)
  → Passes to UE build (UBT)
    ↓
Build completes
  → Record in Supabase: "build 5.2.1 succeeded with assets {A_v3, B_v2, C_v1}"
  → Agents can query: "what assets were used in this build?"
```

---

## Comparison: Perforce vs. This Architecture

| Aspect | Perforce | Our Architecture |
|--------|----------|------------------|
| **Code** | P4 workspace | Git (same as today) |
| **Large assets** | P4 depot (proprietary) | Blob storage (S3, Blob, GCS) |
| **Metadata** | P4 database | Supabase (SQL, relational, observable) |
| **Versioning** | P4 revisions | Git tags + Supabase version numbers |
| **Locks** | P4 lock/unlock | Supabase lock table + polling |
| **Distributed teams** | Expensive seat licenses | Free (cloud-hosted) |
| **Audit log** | P4 filelog | Supabase audit table (queryable) |
| **Dependencies** | Manual tracking | Supabase relational model (queryable, automated) |
| **Integrity** | P4 verify | Checksums in Supabase + blob verification |
| **Collaboration** | P4 have/want | Supabase lock state + admin queue |

---

## Enabling Distributed Game Development

**Current state:** Developers must be co-located or share a local file server.

**This architecture enables:**
- **Remote teams** — asset uploads/downloads happen over API, not local network
- **Async collaboration** — lock/unlock protocol prevents conflicts across time zones
- **Build farms** — multiple build machines (Docker agents) can fetch assets independently, compile in parallel
- **Version control** — audit log shows who changed what asset when, rollback to previous versions
- **Quota management** — track bandwidth, storage, asset counts per team member
- **Search & discovery** — "which levels use this texture?" → query Supabase instead of grep

---

## MVP Roadmap (Post-Launch)

### Phase 1: Remote Ops (Current, THIS WEEK)
- ✅ Supabase coordination
- ✅ Admin queue + polling loop
- ✅ Git/docker/build commands via admin queue
- **Outcome:** Enable remote dev ops, prove Supabase architecture

### Phase 2: Asset Catalogue Extension (Weeks 2-4)
- Extend existing SQL content catalogue
- Add asset metadata table (name, version, checksum, owner, status)
- Add asset lock table (checkout/check-in protocol)
- Add audit log table (who changed what, when)
- Create `/admin/assets/*` endpoints in Fastify (upload, download, lock, unlock, list)
- **Outcome:** Asset versioning + lock protocol works

### Phase 3: Blob Integration (Weeks 4-6)
- Integrate Vercel Blob (or S3)
- Wire upload flow: metadata → Supabase, binary → Blob
- Wire download flow: query Supabase for checksum, fetch from Blob
- Integrity verification (checksum validation)
- **Outcome:** Large asset files can be stored and retrieved reliably

### Phase 4: Build Pipeline Integration (Weeks 6-8)
- Extend UBT build scripts to fetch assets from Supabase/Blob
- Record asset manifest in Supabase per build
- Add "which assets were used in this build?" query
- **Outcome:** Build system can query asset versions and dependencies

### Phase 5: Team Collaboration Features (Weeks 8+)
- Dashboard: show active asset locks (who's working on what)
- Notifications: "TextureA updated, refresh your working copy"
- Conflict detection: "TextureA is locked by Agent-2, your checkout failed"
- Quota enforcement: per-user bandwidth/storage limits
- **Outcome:** Team can see collaboration state in real-time

---

## Why This Matters

**For indie/small studios:**
- No Perforce licensing costs
- Works with existing git workflow
- Scales from 1 person to 50+ team members
- Transparent (SQL queries answer any question about asset state)

**For distributed teams:**
- Asset downloads over HTTPS (works anywhere with internet)
- Async lock/unlock protocol (works across time zones)
- Audit log (who changed what)
- Version history (rollback to previous asset versions)

**For build automation:**
- Build machines can fetch specific asset versions
- Reproducible builds (record which assets were used)
- Parallel builds (multiple agents fetch assets independently)

**For game development specifically:**
- UE doesn't care where assets come from (blob storage or local)
- Can mix git (code) + Supabase/Blob (assets) in single project
- Agents can update assets while humans code
- Humans can code while agents build

---

## Future Extensions

### Compression & Deltas
- Store texture diffs, not full re-uploads
- Compress assets before blob storage
- Reduce bandwidth for remote teams

### Content-Addressed Storage
- Assets stored by checksum (same asset = same storage location)
- Automatic deduplication (if multiple versions reference same texture, store once)
- Integrity guaranteed by hash

### Access Control
- Fine-grained permissions (who can upload/download/lock which assets)
- Supabase RLS (row-level security) for asset rows
- API key rotation, audit logging

### Scheduled Cleanup
- Auto-delete old asset versions (keep last N)
- Archive historical assets (cheap storage)
- Quota enforcement (warn team when nearing limits)

---

## Strategic Alignment

**This architecture is **NOT** competing with Perforce on features.** It's competing on:
1. **Cost** (zero seat licenses)
2. **Transparency** (SQL queries answer any question)
3. **Flexibility** (extend with custom game logic)
4. **Distribution** (works across time zones, continents)
5. **Simplicity** (git + SQL + blob storage, no proprietary complexity)

**For UE game development specifically:**
- Most teams use P4 because "that's what UE supports"
- But UE doesn't *require* P4 — it just reads files
- This architecture provides the same multi-team, large-asset workflow without the licensing burden

---

## Open Questions

1. **Perforce P4 API compatibility:** Should we offer a P4 proxy layer (pretend to be Perforce) so existing teams can migrate without retraining? (Future, probably not MVP.)

2. **Asset merge strategy:** How do we handle conflicts when two developers edit the same texture? (Separate design doc needed.)

3. **Performance at scale:** How many assets/queries can Supabase handle? (Benchmark against Perforce depot sizes.)

4. **Offline mode:** Can developers work offline and sync when reconnected? (Future feature, requires local caching + conflict resolution.)

5. **Enterprise features:** Should we offer managed Supabase hosting, backup, SLA? (Future business model.)

---

## Why This Document Exists

This is **not a spec**. It's a **strategic compass** for the current work:

- When designing the Supabase schema, keep room for asset metadata
- When implementing the admin queue, design endpoints that can route asset commands
- When choosing blob storage, pick something with good checksumming and HTTP API
- When building the polling loop, make it extensible (not just git/docker/build, but asset upload/download too)

The current remote ops work is **phase 1**. The asset platform is the **strategic destination**.

---

## Next Steps

1. ✅ Ship remote ops (Supabase + polling loop) — THIS WEEK
2. ⏳ Gather team feedback on architecture
3. ⏳ Design asset catalogue schema (inventory of game content)
4. ⏳ Prototype asset upload/download flow
5. ⏳ Integrate with UBT build pipeline
6. ⏳ Build team collaboration UI (locks, notifications, search)
7. ⏳ Open-source (if desired) or productize

---

## Conclusion

The Supabase migration enables more than just remote dev ops. It's the **first layer of a distributed game asset platform** that rivals Perforce in capabilities while being cheaper, more transparent, and more flexible.

Start with remote ops. Build toward the platform vision.
