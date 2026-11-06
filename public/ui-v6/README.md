# Éditions Standard B2B — V6 / Zaptix-inspired UI preview

**Branch:** `design/v6-zaptix-preview-2026-11-06`  
**Status:** isolated development branch only. **Not deployed.**  
**No production database, account, order, or Railway configuration changed.**

## Intent

Bring the approved V6 visual direction into the **existing application** — not a replacement mockup:
- Original buyer login and authentication remain untouched.
- Buyer catalogue, brands and product details use the real API and existing cart, quantity, pricing, stock, early-access, payment/return terms and permission logic.
- Admin screens keep their real CRUD actions, permission checks, engagement tools, buyer requests, orders and settings.
- Agent PWA remains mobile-first with its existing real authentication.
- Design: chocolate `#33251F`, ice blue `#B8D3E7`, rounded cards, IBM Plex Sans UI + Plex Mono metadata.
- Responsive rules for desktop, tablet, mobile; reduced-motion support.
- Uses existing `es-theme` preference and automatic 07:00–20:00 light / 20:00–07:00 dark mode from the application.

## Preview controls — only **after** a local or authorized test environment serves this branch

- Buyer: `/portal?ui=v6`
- Admin: `/admin?ui=v6`
- Agent: `/agent?ui=v6`
- Exit preview: `?ui=classic`, or the floating **V6 PREVIEW · Exit** link.
- Preference is scoped to the **browser tab session** and has no server-side effect.
- The original buyer login page `/editions-showroom-b2b-portail` stays unchanged.

**These URLs are not live V6 demos on production at this time.** The production service remains on `main`.

## Changes

- `public/ui-v6/preview.css` — scoped visual layer on top of real screens.
- `public/ui-v6/preview.js` — URL-gated opt-in and exit, no API calls or business logic.
- `public/portal.html`, `public/admin.html`, `public/agent.html` — imports only, no original handlers modified.
- `test/ui-v6-preview.test.js` — static regression and preview-mode tests.

## Before any deployment or merge

1. Run `npm test` and `node --test test/ui-v6-preview.test.js`.
2. Start a local instance with test credentials and test data (never the live buyer database).
3. Inspect 320/375/390/768/1024/1440/1600px views in light/dark, on buyer/admin/agent; verify long content, tables, popups, drawer, price/currency and fixed mobile cart.
4. Verify ordering/minimums, discounts, stock constraints, role isolation, uploads, PDF exports, email flows, appointments, MFA and errors against existing behavior.
5. Audit keyboard navigation, contrast, touch targets, focus, overflow and reduced motion.
6. Obtain explicit approval before any staging deployment, production deployment, merge, or live traffic change.

## Explicit non-goals of this first integration pass

- Does not install a new framework, migrate the backend or modify the database.
- Does not populate real products/brands from mockup values.
- Does not create a CRM or alter Airtable permissions.
- Does not promise pixel-perfect screenshots before test-environment browser QA.

The existing V6 standalone mockup in the conversation is a visual reference only.
