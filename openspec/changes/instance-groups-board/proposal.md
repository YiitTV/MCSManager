# Proposal

## Why

Operators need to see their instance groups alongside the instance controls they already use. The separate Instance groups menu sends them away from the Instances page.

## What Changes

- Add Normal and Grouped views to Instances and remember the selection in the browser.
- Show groups as side-by-side columns with group controls and instance cards in start order, followed by an Ungrouped column.
- Reuse the group editor, run progress, and mini console on Instances.
- Redirect the old Instance groups URL to the Grouped view and remove its menu entry.

## Capabilities

### New Capabilities

### Modified Capabilities

- `instance-groups` — Present each user's groups on the Instances page. The baseline requirement is in the active `instance-groups` change.

## Impact

The Instances widget, frontend routing, group components, locale strings, and frontend tests are affected. The board uses the existing group and instance APIs.
