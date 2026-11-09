# TZ-06 program sequencing boundary

The branch provides an ID-stable program editor controller and browser adapter. Keyboard Move up/Move down controls, pointer drag/drop, live announcements, undo and explicit save failures share one immutable sequence. Saved success snapshots clear the busy state, and undo is enabled only when history exists. Programs must contain 1–1,000 unique normalized song, ad, intro or recurring-block references; arbitrary caller fields are discarded.

A local SQLite store and HTTP boundary persist versioned programs with optimistic conflict checks. A server-verified broadcaster identity, exact station authorization and per-item authorization callback are rechecked inside every write transaction. The item callback is the integration point for TZ-05 rights approval and other trusted gates; a sequence move never authorizes broadcast. UTF-8 request bytes are bounded and client-supplied identity or role claims are rejected.

`node --test tests/program-sequence.test.mjs tests/program-store.test.mjs` covers ordering, accessibility markup, normalization, denial, restart persistence, stale versions, item authorization, request limits and interrupted writes. Distributed Radio Engine DRE-07 is merged through PR #8 and owns broadcaster-independent cycle-boundary activation; this editor persists order and versions but does not claim to be that engine.

Production identity, rights-provider wiring, compiled durations, DRE scheduling, schedule-conflict policy, real browser interaction testing and deployment remain explicit integration or acceptance gates.
