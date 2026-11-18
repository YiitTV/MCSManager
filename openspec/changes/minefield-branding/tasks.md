# Tasks

## 1. Brand assets

- [x] 1.1 Produce `frontend/src/assets/logo.png` from the operator artwork: crop to the wordmark, remove the black background (transparent, feathered edges), and scale to about 600px wide at under 30 KB. Verify by viewing it on dark and light backgrounds in a screenshot, then `cd frontend && npm test`.
- [x] 1.2 Add `frontend/public/favicon.svg` (mine glyph in logo colours), regenerate `public/favicon.ico` from it, and set `<title>Minefield Panel</title>` plus the SVG favicon link in `frontend/index.html`. Verify that the built `dist/index.html` contains both, then `cd frontend && npm test`.

## 2. Palette and default theme

- [x] 2.1 In `useAppConfigStore.ts`, set the Ant Design tokens (`colorPrimary #ff9500`, `colorLink`, `borderRadius 4`) and change the stored-theme default plus `resetTheme()` to `AppTheme.DARK`. Add a unit test asserting a dark default when localStorage is empty and that a stored light preference is preserved. Then `cd frontend && npm run type-check && npm test`.
- [x] 2.2 Override the dark-theme surface, header, card, and border variables in `variables-dark.scss` (near-black and navy), and set near-black text on primary buttons (contrast at least 4.5:1). Verify with screenshots of the login, dashboard, instance list, terminal, and settings pages in both themes, then `cd frontend && npm run lint && npm test`.

## 3. Decorations and copy

- [x] 3.1 Add the CSS-only hazard-stripe accent (login card top edge, under the header) and the inline-SVG minefield background on the login page. Restyle the "Powered by MCSManager" link to the theme while keeping it present. Verify in a screenshot that there are no new font or image network requests (browser devtools or Playwright request log), then `cd frontend && npm test`.
- [x] 3.2 Update the values of the product-name strings (`TXT_CODE_47ae8ee6`, `TXT_CODE_00000001`, `TXT_CODE_5b60ad00`) to say Minefield in every `languages/*.json`. Verify with a grep that no locale still shows "MCSManager" for those keys, then `cd frontend && npm test`.

## 4. Final verification

- [x] 4.1 Run the full frontend gate (`cd frontend && npm run type-check && npm run lint && npm test && npm run build`) and review the diff for unrelated changes. Confirm that the custom logo setting still overrides the default by setting one in a local run.

## Workflow follow-up

- Deploy together with the custom-release deployment change, then archive with `/openspec-archive-change`.
