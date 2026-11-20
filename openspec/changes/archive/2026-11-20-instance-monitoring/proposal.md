# Proposal

## Why

Operators need to see per-server resource pressure and low tick rates across the network and inspect how they developed over the last day.

## What Changes

- Collect per-instance RAM, CPU, and optional spark tick metrics once per minute.
- Keep 24 hours of in-memory history and expose it through a per-instance authorized panel API.
- Display compact metrics and warnings in both list views, with an expanded chart on the instance page.

## Capabilities

### New Capabilities

- `instance-monitoring` provides resource and tick history, access controls, and warning indicators.

### Modified Capabilities

None.

## Impact

Daemon process and Docker metrics, panel instance operations, frontend instance widgets, and translations.
