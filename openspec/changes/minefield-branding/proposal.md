# Proposal

## Why

This deployment runs a private Minecraft network called "Minefield". The panel currently shows stock MCSManager branding (logo, page title, neutral blue/grey theme), so it does not look like the community's own tool. The operator wants the Minefield logo and a military / minefield look that matches the logo, without adding runtime weight to a server whose RAM budget is tight.

## What Changes

- The bundled default logo (`frontend/src/assets/logo.png`) is replaced with the Minefield wordmark: white pixel letters, navy outline on "MINE", brown-to-orange gradient outline on "FIELD", with a transparent background (derived from the operator-provided artwork).
- The browser tab title becomes "Minefield Panel" and the favicon becomes a small Minefield icon (a mine glyph in the logo colors).
- A Minefield colour palette taken from the logo is applied through the existing theme system: near-black surfaces, navy (`#3b4466`) borders and secondary accents, and an orange (`#ff9500`) primary colour, with rust brown (`#7a3418`) as the hover/pressed shade.
- The dark theme becomes the default for first-time visitors; the existing light / dark / auto switch keeps working, and the light theme picks up the same orange primary colour.
- Lightweight decorative drawings are added: a hazard-stripe accent and a subtle minefield pattern on the login page and header, implemented as inline CSS/SVG (no image downloads, no web fonts).
- User-facing strings that name the product in the panel chrome ("MCSManager Panel", "Welcome to the MCSManager Panel", "Log in to the MCSManager Control Panel") show "Minefield" instead, in all shipped locales.
- The "Powered by MCSManager" link on the login card is kept (Apache-2.0 attribution), restyled to fit the theme.
- The existing admin settings for a custom logo and background image keep precedence over the new defaults.

## Capabilities

### New Capabilities

- `panel-branding`: The panel's default visual identity: logo, page title, favicon, default theme and palette, and the precedence of operator-configured logo/background over the bundled defaults.

### Modified Capabilities

(none)

## Impact

- `frontend/src/assets/` (logo, new favicon/mine SVG, theme SCSS variables), `frontend/index.html`, `frontend/public/favicon.ico`.
- `frontend/src/stores/useAppConfigStore.ts` (default theme, Ant Design colour tokens).
- `frontend/src/widgets/LoginCard.vue`, `frontend/src/components/AppHeader.vue` (decorations, attribution styling).
- `languages/*.json`: the product-name strings listed above.
- No backend, API, data-format, or permission changes. Server RAM impact is nil: these are static assets served once and cached by the browser. The bundle size grows by only a few KB (the logo image).
