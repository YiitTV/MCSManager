# Design

## Context

The theme system already exists:
- `useAppConfigStore` holds an Ant Design Vue `ThemeConfig` (algorithm and tokens), the light/dark/auto preference in localStorage (`THEME_KEY`, default `AppTheme.LIGHT`), and the logo URL. The logo defaults to `@/assets/logo.png` and can be overridden by `settings.theme.logoImage`.
- CSS custom properties for the dark theme live in `src/assets/variables-dark.scss` (`.app-dark-theme`), and those for the light theme in `variables.scss`.
- The logo is rendered at 18px height in `AppHeader.vue`, and also in `LoginCard.vue`.

The operator supplied the artwork as a 2000×1116 JPEG on a black background (`openspec/changes/minefield-branding/assets/minefield-logo-source.jpg`). It needs cropping and a transparent background before it can be used.

## Goals / Non-Goals

**Goals:**
- Swap identity and palette by changing defaults and tokens only, reusing the existing theme plumbing.
- Keep the custom logo and background settings working and taking precedence.

**Non-Goals:**
- No layout restructuring. The vertical group view and mini consoles belong to a separate change.
- No backend changes and no new settings fields.
- No renaming of code identifiers, package names, the daemon, or log text. Only user-visible chrome changes.

## Decisions

1. **Logo asset: process the provided JPEG into a transparent WebP/PNG.** Crop the artwork to the wordmark's bounding box with a small margin, turn the pure-black background transparent (alpha from luminance below a threshold, with edge feathering), and downscale to about 600px wide. This is enough for 2× displays at the 18–40px heights used. The target size is under 30 KB. *Alternative:* redraw the wordmark as SVG. Rejected, because the operator asked for the original artwork.
2. **Favicon: hand-written SVG mine glyph plus an `.ico` fallback.** A circle with spikes, in navy with an orange highlight, written inline as `public/favicon.svg` and linked from `index.html`. The existing `favicon.ico` is regenerated from the same glyph for older browsers.
3. **Palette via Ant Design tokens plus existing CSS variables.** Set `token.colorPrimary = #ff9500`, `colorLink`, and `borderRadius` (slightly squarer, 4px, for the military look) in the shared `theme` object. In `.app-dark-theme`, override the background, header, card, and border variables to near-black (`#0e0f12` / `#16181d`) and navy (`#3b4466`). Text on orange buttons uses near-black (`#111`) to reach a contrast ratio of at least 4.5:1, because white on `#ff9500` fails it. *Alternative:* a new custom theme mode. Rejected as more surface area for the same result.
4. **Default theme: change the `useLocalStorage` default from `AppTheme.LIGHT` to `AppTheme.DARK`.** `useLocalStorage` only uses the default when nothing is stored, so existing preferences are preserved. `resetTheme()` (used for invalid stored values) also resets to dark.
5. **Decorations: CSS only.** A thin hazard-stripe bar (`repeating-linear-gradient`, orange and black) on the login card top edge and under the header. A faint minefield pattern on the login background (an inline SVG `background-image` data-URI under 1 KB). No raster images and no web fonts.
6. **Strings: edit locale JSON values, not keys.** Change the values of `TXT_CODE_47ae8ee6`, `TXT_CODE_00000001`, `TXT_CODE_5b60ad00`, and the `index.html` title in all locales under `languages/`. Keys stay unchanged, so `npm run i18n` is not needed. Daemon and log strings are left alone (non-goal).

## Risks / Trade-offs

- [Upstream merges touch the same files (`variables-dark.scss`, locale JSON)] → Keep edits small and localized, and the values-only locale changes are easy to re-apply after a merge.
- [JPEG artifacts around the letter edges after background removal] → Use a luminance threshold with feathering, inspect the result on both themes in a screenshot, and tune the threshold if a halo is visible.
- [Some third-party Ant Design components ignore tokens] → Check the main pages (dashboard, instance list, terminal, settings, login) in a screenshot pass, and patch the outliers in `variables-dark.scss`.

## Migration Plan

This is a frontend-only build. It is deployed with the rest of the custom release (separate deployment change). Rollback means redeploying the previous frontend build. No data migration is needed. Users who had explicitly chosen the light theme keep it.
