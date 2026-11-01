# TZ-21 discovery and station sharing

The draft renders a bounded public list of station names and descriptions with canonical HTTPS links to each live station page. It escapes metadata, rejects duplicate or malformed station IDs and uses a configured share origin. The page has a restrictive content security policy and includes no listener identity, media URL, token, on-demand selection or event coordination.

`node --test tests/discovery.test.mjs` passes three local Node 24 tests for canonical links, hostile records/origins and provider outage. The station list must come from a trusted published-station provider; integration with TZ-20 moderation and actual live player routing, product CI, accessibility/browser checks and production validation remain open. This is a metadata shell, not a verified listener or release.
