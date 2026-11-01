# TZ-12 iOS listening slice

The draft SwiftUI view and model provide deliberate live-station play/stop, an accessible status, cancellation-safe joins and an injected endpoint-encrypted DAE session boundary. Playback has no raw URL, song picker, seek or reward controls. A new join waits for the previous operation and asynchronous session close, avoiding overlap when a user quickly changes stations or stops and restarts. An XCTest source case covers a delayed close and subsequent join order.

There is no Swift compiler, Xcode, iOS SDK, simulator or device in this isolated runtime. The new test was written but could not be run here; the repository's planning check does not compile Swift or run XCTest. The actual DAE-10 native SDK, DRE guest stream and catalog, background audio/media controls, route recovery and device/battery tests remain unavailable. PR #17 stays draft and makes no working iOS listener or field claim.
