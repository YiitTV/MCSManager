## Purpose

Let administrators control admissions to the Minecraft network through Velocity.

## ADDED Requirements

### Requirement: Network maintenance controls
The panel SHALL let administrators read and set the global Maintenance plugin state on Velocity and view, add and remove valid player names from its allowlist.

#### Scenario: Missing plugin
- **WHEN** an administrator views a Velocity instance without the plugin directory
- **THEN** the card SHALL show that the plugin is missing

#### Scenario: Apply an edit
- **WHEN** an administrator changes the state or allowlist of a running proxy
- **THEN** the daemon SHALL use the plugin console commands and return the state observed in the plugin files

#### Scenario: Regular user
- **WHEN** an assigned regular user requests any maintenance endpoint
- **THEN** the panel SHALL deny the request before contacting the daemon
