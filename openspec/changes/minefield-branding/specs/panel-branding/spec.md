# Spec Delta

## Purpose

Defines the panel's default visual identity (logo, title, favicon, theme palette, default theme) and how operator-configured branding overrides those defaults.

## ADDED Requirements

### Requirement: Default logo is the Minefield wordmark
The frontend SHALL display the Minefield wordmark as the default logo in the application header, the sidebar, and the login card when no custom logo is configured. The logo SHALL have a transparent background so that it renders cleanly on both the light and dark themes.

#### Scenario: No custom logo configured
- **WHEN** a user opens the panel and the layout settings carry no custom logo image
- **THEN** the header and login card show the Minefield wordmark

#### Scenario: Custom logo configured
- **WHEN** an administrator has set a custom logo image in the layout settings
- **THEN** the custom logo is shown instead of the Minefield wordmark

### Requirement: Page title and favicon identify Minefield
The browser document title SHALL be "Minefield Panel", and the favicon SHALL be the Minefield icon.

#### Scenario: Opening the panel in a browser tab
- **WHEN** a user loads any panel page
- **THEN** the tab shows the Minefield icon and the title "Minefield Panel"

### Requirement: Minefield colour palette
The frontend SHALL use orange (`#ff9500`) as its primary accent colour in both the light and dark themes. In the dark theme it SHALL use near-black surfaces and navy (`#3b4466`) borders and secondary accents. Text on primary-coloured controls SHALL keep a contrast ratio of at least 4.5:1.

#### Scenario: Primary button in dark theme
- **WHEN** the dark theme is active and a primary button is rendered
- **THEN** the button uses the orange primary colour with legible text that meets the contrast ratio

#### Scenario: Light theme still available
- **WHEN** a user switches to the light theme
- **THEN** the panel renders in the light theme with the orange primary colour

### Requirement: Dark theme is the default for new visitors
A browser with no stored theme preference SHALL start in the dark theme. A stored theme preference (light, dark, or auto) SHALL be honoured unchanged.

#### Scenario: First visit
- **WHEN** a browser with no saved theme preference opens the panel
- **THEN** the dark theme is applied

#### Scenario: Existing preference
- **WHEN** a browser has previously saved the light theme
- **THEN** the light theme is still applied after the upgrade

### Requirement: Product name in panel chrome
User-facing strings that name the product in the panel chrome (welcome text, login heading, panel name) SHALL say "Minefield" in every shipped locale. The login card SHALL keep a "Powered by MCSManager" attribution link.

#### Scenario: Login page in Turkish
- **WHEN** the panel language is Turkish and the login page is shown
- **THEN** the heading names Minefield, and a "Powered by MCSManager" link is still present

### Requirement: Branding adds no runtime load
Branding assets SHALL be static files that the browser caches. They SHALL NOT add web-font downloads, network requests on each page view beyond the cached assets, or any server-side processing.

#### Scenario: Repeat visit
- **WHEN** a user reloads the panel after a first visit
- **THEN** the logo and favicon are served from the browser cache, and no additional font or image requests are made for decorations
