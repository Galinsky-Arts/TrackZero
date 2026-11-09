# TZ-10 guest web player and album pages

The draft renders public station and complete-album metadata, with explicit-play live-session controls and an accessible status. Station and album text is escaped. Artwork requires an operator-configured HTTPS origin allowlist, and the page content security policy permits images only from those origins. There is no song picker, skip, on-demand playback, media URL, playback token or private manifest in server-rendered HTML.

The transport-neutral `GuestPlayer` requires a trusted DRE live adapter with `joinLive(stationId, {signal})` returning a session with `start()` and `close()`. Stop aborts pending joins and closes sessions; late joins cannot start playback. Synchronous or asynchronous close failures clear the stale session and show interruption rather than a false playing state. The host still must bind controls, provide guest authorization and preserve endpoint-encrypted media; no DRE-11 interface or actual browser playback has been verified here.

The November 9 review integrates the actual DRE-11 playback SDK through
`createDreGuestAdapter`. Its lifetime promise is distinct from first-frame
readiness; later source failure interrupts the UI. Cleanup must complete before
another join, and cleanup failure seals the controller. Station snapshots must
match the requested station. Trusted application code supplies endpoint,
transport and station-verification adapters; no substitute encryption is added.

All 87 local tests pass on Node 24.22.1 with
`DRE_PLAYBACK_MODULE=/path/to/radio/src/radio-playback.mjs`. CI checks out DRE
source `79e9cb919813769a79f9a8bdabbe560a10f48ab8` and runs the same integration, including
first-frame readiness and subsequent stream loss. The source uses explicit
ciphertext/endpoint fixtures: real browser media, native output, production
identity, endpoint enrollment and deployed streaming still require integration.
TZ-09 is merged; no field or production playback completion is claimed.
