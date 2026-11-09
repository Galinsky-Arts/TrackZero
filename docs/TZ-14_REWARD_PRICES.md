# TZ-14 reward price preview and ladder

The draft implements a bounded BigInt price curve with exact rational interval rounding, and renders an artist-specific versioned offer with exact cost and spendable balance. The default starts slowly and rises sharply at higher tiers; the UI does not convert a display snapshot into a reservation, unlock or spend. An issuer must recheck offer version, inventory, artist balance and atomic redemption.

The render boundary now rejects forged non-boolean availability, malformed identifiers, negative balances, zero costs and inconsistent request eligibility. `node --test tests/*.test.mjs` passes five local Node 24 tests, including early/late curve growth, large integer handling, exact one-point-short preview and cross-artist denial.

No DRE-17 trusted artist pricing authority, versioned offer issuer, live wallet or inventory has been verified in this assignment. The original plan also depends on TZ-05 and TZ-13, which remain draft. The planning CI does not run this product suite, and the 1000-speaker/all-day economic model needs real accrual policy data before it can be simulated faithfully. PR #19 remains draft; no redemption or release is claimed.

November 9 review removes duplicated price arithmetic and the old tier-100
restriction. `createRewardPricing` delegates to the pinned actual DRE-17 price
policy and quote functions. Large tiers remain symbolic under a computation
budget and cannot be displayed as executable costs. Creator IDs and policy
versions remain bound, and exact integer balances/costs support 1000 digits.
CI exercises the actual immutable upstream source; display still authorizes
no spend. Atomic issuance belongs to DRE-18.
