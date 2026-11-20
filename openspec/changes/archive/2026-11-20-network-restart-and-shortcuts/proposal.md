# Proposal

## Why

Network operators need to warn players before restarting several servers in sequence. Repeated console operations also need a convenient way to run an administrator-curated command.

## What Changes

- Add a manual warned restart to group board headers and the group API.
- Add editable warning offsets and text to group settings.
- Add per-instance console shortcut editing and execution to both consoles.

## Capabilities

### New Capabilities

- `warned-group-restart` covers the warning countdown and ordered lifecycle.
- `console-shortcuts` covers saving and executing shared instance commands.

### Modified Capabilities

## Impact

The panel owns countdowns, shortcut persistence, permissions, and command dispatch. The daemon supplies the configured server type with batch status. The frontend adds board controls and shared console shortcut controls.
