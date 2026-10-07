# Buyer journey upgrade

Preserves the portal art direction and the existing nonbinding buyer proposal → agency signature → final order workflow. Orders remain one per brand. Server pricing, brand permissions, early access, MFA, CGV acceptance, signatures and atomic stock consumption remain authoritative.

## Migrations

`database.js` invokes transactional, advisory-locked idempotent migrations:

- `lib/min-reference-migration.js`: brand minimum and buyer override; seeds WODD minimum 3 once. Reuses the production function and existing BEFORE trigger, adding deferred aggregate validation when necessary. No production objects are dropped. Quantities sum across sizes/colors and product IDs with the same reference. Unrelated changes to historical lines do not revalidate legacy quantities.
- `lib/buyer-account-migration.js`: optional order PO and frozen effective terms; activation flag defaults false for existing accounts; proposal stages and order linkage; companies, locations, memberships, hashed invitations and buying shortlists with indexes. Legacy company strings remain and each buyer gets an isolated company, never merged by name.

## Buyer behavior

Generic negotiated minima drive catalogue, drawer, editable cart, agent selection, reorder and Quick Order. Old saved carts retain valid sizes/colors and normalize reference deficits. Cart identity includes brand, product, color and size. Product-controlled values use escaped data attributes and delegated quantity handlers.

WODD €3,500 remains a recommended opening order because `moq_strict=false`. Only existing strict global MOQ settings block checkout. Order review and confirmation display effective terms, pieces, references, totals and PO. Reorder reconciles current prices, availability, variants and minimum before adding.

New approvals send a single-use activation link (32 random bytes; SHA-256 hash stored; 60 minute expiry). Existing active accounts keep their password. Password-reset consumption is atomic. Selection password minimum is 12 characters and existing buyer MFA must complete through the portal.

Translations retain cached entries and fall back to source without caching failures; provider requests time out after eight seconds and use exponential backoff, with a 15 minute pause on configuration/credit failures. Push configuration errors disable/pause push without blocking checkout or emails; secrets are untouched.

Favorites stay personal. Named buying shortlists support notes, optional company sharing, review readiness and CSV export. Company owners manage billing, locations and email-bound invitation links; company joining requires an existing authenticated buyer. Quick Order accepts reference search, variants/sizes, CSV and pasted rows, reconciles server values, then adds to the same cart. Agent selection links remain valid, support buyer comments/conditions and progress through buyer approval to agency signature.

## Validation

34 Node tests pass against isolated PostgreSQL 16 databases. Coverage includes WODD minima/overrides, direct API rejection, split variant aggregates, multi-brand orders, current-price reorder, PO confirmation, Quick Order, selection approval, hashed single-use activation, company isolation/sharing, provider backoff, authentication, IDOR/PDF access, CSV and performance checks.

All inline scripts in portal, selection, admin and login parse; server/library syntax and `git diff --check` pass. Real Chromium at 390×844 verifies inch sizes, quantity steps, distinct colors, direct cart editing, nonblocking recommendation, no horizontal overflow and no page errors. Reproduce with a Playwright installation:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers node scripts/buyer-mobile-smoke.cjs
```

## Deployment and limitations

No staging environment was configured; validation used local isolated databases. Production currently has no VAPID private key configured, so push remains disabled and email is retained. No secrets or diagnostic services are changed.

New company addresses are account metadata; existing order address fields and historic company strings remain compatible. Company invitations require approved buyer accounts. Shared shortlist editing is owner-only; export is CSV, with review readiness rather than a complex approval engine. New auxiliary tools provide FR/EN copy and source fallback for other languages; existing translations remain.

## Manual buyer smoke checklist

1. WODD ordinary buyer: catalogue/drawer/cart steps 0→3→4 and 3→0, including inch sizes; €3,500 is recommended and does not block.
2. Admin sets buyer minimum 1, then 2, then blank: portal and selection reflect the negotiated/default value before first order.
3. Same reference/size in Gold and Silver stays as two lines; split quantities 2+1 pass. Restore an old saved cart and check selections survive.
4. Check cart numeric editing, CGV checkbox and signature on iPhone; review payment/delivery terms and totals.
5. Order two brands with optional PO: two confirmation cards/order numbers, correct history and PDFs, then agency signs the proposal.
6. Reorder after a price change or unavailable reference: review reconciliation before adding. Check Quick Order CSV and variants.
7. Activate a new approval link, verify it cannot be reused, and verify existing MFA accounts still log in.
8. Invite another approved company user; private Favorites/lists stay private, explicitly shared list appears only inside that company.
9. Check FR/EN, existing other-language catalogue and cached translations during provider failure; emails remain reliable with push disabled.
