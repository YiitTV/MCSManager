# Spec Delta

## Purpose

Provide administrator-curated commands to users who can operate a server from either console.

## ADDED Requirements

### Requirement: Instance-scoped shortcut storage
The panel SHALL store at most 20 named shortcuts per daemon and instance pair. Only administrators SHALL write the list. Shortcut commands SHALL contain at most 200 characters and SHALL reject line breaks and control characters.

#### Scenario: Shortcut list is shared by assigned operators
- **WHEN** an administrator saves valid shortcuts
- **THEN** administrators and users assigned to that instance can read them in both the mini console and terminal
- **AND** the shortcuts remain available after a panel restart

#### Scenario: Suggestions start unsaved
- **WHEN** an administrator opens a shortcut editor
- **THEN** it offers command suggestions without creating any shortcuts until explicitly saved

### Requirement: Saved shortcut execution
The panel SHALL check current instance access and resolve a selected shortcut from storage before delivering its command through the existing instance command path.

#### Scenario: Unassigned caller attempts access
- **WHEN** a regular user reads or runs a shortcut for an unassigned instance, or tries to edit any shortcut list
- **THEN** access is denied

#### Scenario: Shortcut changes before execution
- **WHEN** the client requests a shortcut that has since been replaced or deleted
- **THEN** no command is dispatched for the stale shortcut identifier
