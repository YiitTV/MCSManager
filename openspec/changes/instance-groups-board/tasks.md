# Tasks

## 1. Instances navigation

- [x] 1.1 Add a persisted Normal/Grouped switch, redirect the legacy route, and remove the separate menu entry. Verify with `cd frontend && npm test`.

## 2. Board and actions

- [x] 2.1 Load all available instances for the board and render group columns, ordered and shared members, muted unavailable members, and a final Ungrouped column. Reuse the existing cards. Verify with `cd frontend && npm test`.
- [x] 2.2 Move group editing, operations, progress, and mini consoles into Instances. Close mini consoles on departure and remove the standalone page. Add the required locale strings. Verify with `cd frontend && npm test`.

## 3. Verification

- [x] 3.1 Cover the board layout and membership, run controls, unavailable members, and view persistence with component and hook tests. Update existing group component tests for the new layout. Verify with `cd frontend && npm run type-check && npm test && npm run lint`.
- [x] 3.2 Validate the delta with `openspec validate instance-groups-board` and confirm the frontend suite with `cd frontend && npm test`.
