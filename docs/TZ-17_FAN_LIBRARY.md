# TZ-17 fan library and downloads

The draft renders purchased works, point redemptions and separate Unlocked Grooves as distinct trusted entitlement records. An authenticated `GET /v1/library` endpoint derives tenant, application and listener account from the server-side identity adapter, fetches grants for that exact scope and rejects any cross-user or cross-tenant row. The HTML is escaped, has a restrictive content security policy and does not contain media URLs, keys or download capabilities. A revoked record cannot advertise a download. Radio listening remains a live linear station.

`node --test tests/*.test.mjs` passes three local Node 24 tests for distinct records, cross-scope/duplicate/revoked denial, and authenticated endpoint behavior. The planning CI does not run these product tests. The original plan requires TZ-15, TZ-16 and DRE-23; no verified entitlement issuer, creator download authorization or endpoint-encrypted delivery contract is available in this assignment. No download endpoint can safely issue a capability until that authority is integrated. PR #22 stays draft; no purchase access or media release is claimed.


November 9 review requires an approved endpoint response encoder for private
library pages. The HTTP response contains only an authenticated encrypted control
envelope; decryption and rendering occur at the authorized client endpoint.
Pages are bounded to ten viewer-scoped entries with a validated encrypted next
cursor, preserving the distinction among purchases, point redemptions and Grooves.
No raw media URL, key or download authority is inferred from a rendered card.
Production source providers and actual authorized download channels remain required.
