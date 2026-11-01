# TZ-13 Contribute Sound setup and evidence UI

The draft provides explicit microphone opt-in, conservative route status and accessible controls. Listening works without capture. The UI never grants points: consent, a connected speaker or a route assertion alone is not qualified output evidence, and complete-broadcast vesting remains with Distributed Radio Engine.

The host must supply a trusted route probe and a route-change subscription. The UI rechecks the trusted probe after every route signal; switching away from a verified active Bluetooth speaker or losing the route stops microphone tracks and interrupts measurement. Disabling during a pending permission or route response invalidates that response. The subscription is removed on disposal. These are local safety controls, not calibrated acoustic evidence or a point issuer.

`node --test tests/*.test.mjs` passes eight local Node 24 tests for opt-in, denied permission, unverified/headphone/inactive routes, route loss, delayed results, cleanup and disclosure. Product tests are not run by the planning CI. The original TZ-13 plan depends on TZ-12 and DRE-13; their native attestation, calibrated processing and issuer interfaces are not independently verified in this assignment. No device or field qualification is claimed; PR #18 remains draft.
