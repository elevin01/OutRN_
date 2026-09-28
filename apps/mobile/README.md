# OutRN mobile

The Expo app lives here; the recommendation engine stays in `packages/engine`. Mobile imports only
`@outrn/contracts` and talks to the v1 API over HTTP. It can run against the existing mock API with
no database. No contract or backend changes are required.

## Run

Use Node 22.13+ and the repository's pinned pnpm 10.28.0 (`corepack pnpm`).

```bash
corepack pnpm install
cp apps/mobile/.env.example apps/mobile/.env
# In apps/mobile/.env, set EXPO_PUBLIC_DEMO_MODE=true for the mock below.
corepack pnpm api:mock                 # terminal 1
corepack pnpm mobile:dev               # terminal 2, Expo dev server
# Or: corepack pnpm mobile:web
```

For a physical phone, set `EXPO_PUBLIC_API_URL=http://YOUR_COMPUTER_LAN_IP:4000` and run the API
with `HOST=0.0.0.0 corepack pnpm api:mock`. Both devices must be on the same network. Android
emulator hosts usually use `http://10.0.2.2:4000`; iOS Simulator can use localhost. Restart Expo
after changing environment variables. When running the real API beyond localhost, set `OUTRN_OPS_TOKEN`; it is a server-only secret and must never use an `EXPO_PUBLIC_` name. Native builds require the SDK 57 development environment;
this repo does not contain signing credentials or an EAS project registration.

The explicit demo switch adds a persistent invented-data banner and permits the fixture's pinned
plan times for review. It does not change responses, rank results, or fabricate venues. The mock
ignores filter semantics and echoes selections; use a real API to validate actual recommendation
changes. For the real API, use its address and set `EXPO_PUBLIC_DEMO_MODE=false`. Public Expo
environment variables are bundled into the app; never put secrets in them. Release builds require an explicit HTTPS API endpoint (explicit loopback previews are allowed) and
production APIs must allow the web preview's origin if web access is required.

Approved design, review fixes and current screenshots: [APPROVED.md](docs/APPROVED.md).

## Included

- Warm paper, DM Sans, orange actions, category artwork, accessible 44+ point controls, safe areas,
  native stack navigation, and Now / Saved / You tabs.
- One activity per screen, a right-side Save / Maps / Next rail, swipes between photos, scrolling details, hidden filters, API-generated
  area choices, frozen cursor paging, pull to refresh,
  low-supply explanations, expired searches, connection errors, and loading states.
- Details with every required caveat, age restriction, unknown price, per-fact evidence, and source
  attribution. Estimates remain estimates. Clock times use the response area's timezone.
- Saved place identities in device storage; current details are fetched when opened. Saving does not
  cache eligibility, hours, or a recommendation. Storage failures are visible.
- Session-only outing, directions handoff, manual arrival, and finish. A selected outing survives
  tab navigation but deliberately does not survive process restart. No location permission is used.
- Validated HTTP responses, request cancellation, a 15-second timeout, and safe external URL schemes.

The contract has no image field. Production uses original decorative category artwork. Demo mode
uses bundled mood photography with an explicit “not the venue” label; see
[photo sources](assets/photos/README.md). Accurate venue photography needs a separate data change.
DM Sans is bundled
under the SIL Open Font License; see `assets/fonts/OFL.txt`.

## Remaining product slices

Account sync, submission of venue corrections, taste-feedback services, persistent outings,
device-location entry, accurate venue photography, community feeds, live conditions and a geographic map view need separate PRs.
There are no simulated successful sign-ins or report submissions. Filters are session-only.
The mobile search currently starts from the area center. Contract-supplied origins are labeled correctly; the app does not request device location.
Admission checks and booking happen with the venue; OutRN does not make a reservation.

## Validate

```bash
corepack pnpm mobile:typecheck
corepack pnpm --filter @outrn/mobile lint
corepack pnpm test
corepack pnpm check:boundaries
EXPO_PUBLIC_API_URL=https://YOUR_API_HOST EXPO_PUBLIC_DEMO_MODE=false corepack pnpm mobile:export
# Exports clear the Metro cache and verify that demo photos do not ship in production.
```

CI checks mobile lint, typecheck, and all-platform export. Native device QA, VoiceOver/TalkBack,
keyboard behavior, large system text, maps handoff, and signing remain required before release.
The Expo web preview is useful for UI review, but is not a replacement for native device testing.

All changes use a new branch and a pull request. Do not merge directly to `main`.
