# minecraft-player-management Specification

## Purpose

Give operators a current roster and typed player commands for assigned Minecraft instances.

## Requirements

### Requirement: Instance roster
The board SHALL provide the existing ping count and parsed online names for running Minecraft Java servers and Velocity. A daemon SHALL ask for names at most once per 30 seconds per instance.

#### Scenario: Names are unavailable
- **WHEN** the daemon cannot obtain a recognized reply
- **THEN** the panel SHALL show that names are unavailable and display the ping count when available

### Requirement: Audited player actions
The panel SHALL allow assigned users and administrators to send kick, ban, pardon, op, deop, whitelist add or remove, and private messages to an eligible game server. It SHALL validate inputs and audit each dispatched action.

#### Scenario: Invalid or unassigned request
- **WHEN** a player request is invalid or targets an instance outside the caller's assignments
- **THEN** the panel SHALL reject it without dispatching a command

#### Scenario: Offline target
- **WHEN** an operator needs to pardon a banned player
- **THEN** the player panel SHALL accept a typed player name

#### Scenario: Velocity roster
- **WHEN** a caller opens a Velocity roster
- **THEN** the panel SHALL display the roster with a notice to manage players on their assigned game server
