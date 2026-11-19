# Design

## Context

The administrator-only `/instances` layout hosts `InstanceList.vue`. Its node-specific grid already renders `Shortcut.vue`, while its all-nodes mode uses a table. Regular users see their assigned instances in `UserInstanceList.vue` on the user dashboard. The separate `/instance-groups` view is available to both roles and owns group actions and mini consoles. Its row order currently changes when a stop run is active.

The `Instance groups page` requirement is defined by the active `instance-groups` change. The board modifies that requirement by name. When syncing the changes to the main specs, apply the original change before this one.

## Goals / Non-Goals

- Add a persisted Grouped view to Instances and preserve the existing Normal list, including its filters, pagination, and all-nodes table.
- Reuse the existing group APIs, editor, card actions, progress polling, and mini console store.
- Keep the work within the frontend, locale strings, and OpenSpec artifacts.

## Decisions

- Make `/instances` accessible to both roles. Keep the administrator layout and reuse the assigned-instances list for the regular user's Normal view. Guard browser storage reads and writes. Redirect `/instance-groups` to `/instances?view=grouped` and consume the override so the user can switch views afterward.
- Build board inventory from the paginated all-nodes listing for administrators and the existing assigned-instance APIs for regular users. Use daemon ID and instance UUID together to resolve member cards and filter Ungrouped. Use the group service's member order, including during stop runs. Show a muted placeholder for an unavailable member, with its run status when present.
- Move the group action and editor workflow from the standalone view into the board. Keep the existing run hook and pass card actions through the existing Shortcut component. Show only the actions permitted for the user's role and provide a Mini console action in the card's action area.
- Mount the mini console host at the Instances page level so open consoles can survive a view switch. Close them when the user leaves Instances.
- Use fixed-width columns in a horizontally scrollable container and switch to stacked, full-width columns at the phone breakpoint.

## Risks / Trade-offs

- The Normal view's filtered or paginated results are an incomplete inventory for the board. Fetch board inventory only when needed and follow the existing pagination contract.
- Access or node availability can change after a group is saved. Use server-provided availability and inventory when showing actionable cards, and leave authorization to the existing APIs.
