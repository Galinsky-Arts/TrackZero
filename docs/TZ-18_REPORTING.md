# TZ-18 artist and sponsor reporting slice

The draft adds an authenticated, scoped report boundary for artists and sponsors. Its host must verify the local account, authorize the exact report subject, and load counts from trusted output, payment or campaign issuers. Reports reject cross-tenant or cross-application data. Missing evidence is shown as unavailable, not a zero. Counts are exact decimal strings with source, evidence identifier and observation time; the browser cannot submit measurements or financial totals. The response is uncached with a restrictive content security policy.

`node --test tests/reporting.test.mjs` passes three local Node 24 tests for authorized display, cross-scope denial and malformed/unverified metric rejection. Real DRE-25 output and campaign evidence, transaction provider records, issuer integration, product CI and field validation remain unavailable in this assignment. No artist payment, sponsor delivery or production reporting result is claimed.
