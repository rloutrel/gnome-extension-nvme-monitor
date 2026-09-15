---
name: gnome-knowledge-cache
description: 'Use when preparing or refreshing the local GNOME extension knowledge base: GJS APIs, GTK4 documentation, GNOME Shell 50/51 migration guides, constraints, libraries, and review practices. Refresh at most once per day unless explicitly forced.'
argument-hint: 'Refresh the daily GNOME/GJS/GTK4 knowledge cache, optionally with force.'
---

# GNOME Knowledge Cache

## Purpose

Build one local, dated representation of the external knowledge needed by the
GNOME Extension Developer agent. This reduces repeated documentation calls while
keeping the cache refreshable and auditable. The cache is generated data and is
ignored by Git; source URLs and the refresh policy remain in the repository.

## Procedure

1. Run [the cache builder](./scripts/build-knowledge-cache.sh) from the
   repository root.
2. Unless `GNOME_KNOWLEDGE_FORCE=1` is set, stop successfully when today's
   manifest already exists. This enforces at most one refresh per calendar day.
3. Read `.cache/gnome-extension-knowledge/index.md` before consulting live
   documentation. It contains the current target constraints and links to local
   source snapshots.
4. Use the snapshots for orientation, but verify time-sensitive or uncertain
   API details against the official live source before making a risky change.
5. Use `GNOME_KNOWLEDGE_FORCE=1` only when a migration release, source update,
   or failed refresh requires an immediate rebuild.

## Sources captured

The builder captures official or project-recommended sources for:

- GJS Guide and GJS API reference
- GTK4 API and migration documentation
- GNOME developer platform guidance
- GTK4 + GJS Book resources
- GNOME Shell 50 and 51 upgrade guides
- GNOME extension best practices and review guidance

Each snapshot includes its URL, retrieval timestamp, and HTTP failure status if
available. A partial cache is reported as partial; it must not be presented as
complete API coverage.

## Agent usage

The knowledge cache is a context accelerator, not a replacement for source
provenance. Quote the local snapshot path and source URL in research notes. Do
not silently treat cached documentation as newer than its manifest date. Keep
repository-specific rules in `AGENTS.md`; keep external facts in this cache.
