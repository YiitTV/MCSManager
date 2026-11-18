# Spec Delta

## ADDED Requirements

### Requirement: Fork build version marker
A version with more than three dotted numeric segments (for example `10.22.1.1`) SHALL be a comparable dotted numeric version that sorts after its base and before the next patch release. A non-numeric suffix (for example `-minefield.1`) SHALL remain malformed and never be offered.

#### Scenario: Four-segment version is newer than its base
- **WHEN** the running version is `10.22.1` and a manifest advertises `10.22.1.1`
- **THEN** the system offers the update

#### Scenario: Four-segment build is not offered its own version
- **WHEN** the running version is `10.22.1.1` and the manifest advertises `10.22.1.1` or `10.22.1`
- **THEN** no update is offered and an explicit update attempt reports that the current version is already the latest

#### Scenario: Next patch release supersedes a fork build
- **WHEN** the running version is `10.22.1.1` and the manifest advertises `10.22.2`
- **THEN** the system offers the update

#### Scenario: Text suffix is malformed
- **WHEN** a manifest advertises `10.22.1-minefield.1`
- **THEN** the system reports no new version (fail-closed)

#### Scenario: Cleared sources keep updates off across restarts
- **WHEN** an operator has cleared both `updateSourceUrl` and `updateSourceUrlFallback` and the process is restarted
- **THEN** both fields remain empty and no update information is reported or offered
