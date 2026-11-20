# Design

## Context

The instance board already exposes ping counts. Velocity has a typed instance config and a built-in `glist all` command. Its built-in command set does not include the Paper player actions.

## Goals / Non-Goals

Expose maintenance on the proxy card and a player panel on running Minecraft Java cards. Apply player actions on the selected game server and keep proxy rosters informational. Support the Maintenance plugin's local YAML storage.

## Decisions

- Authorize each panel endpoint using the existing role and instance-assignment checks. Pass only typed requests over the authenticated daemon socket. Validate and build fixed commands server-side. Reuse the instance command preset.
- Read the Maintenance plugin's state and UUID-to-name whitelist from bounded, workspace-confined YAML files. The upstream list command is called `maintenance whitelist` and produces localized output. File reads provide the list independently of locale and while the proxy is stopped. Check observed state after a mutation to distinguish dispatch from an applied change.
- Capture only bounded roster responses from the current instance, with finite deadlines and a shared 30-second cache per live process. Read counts from the existing ping state.
- Record the target and action in the operation log, omitting private message bodies. Add names as selectable targets and accept manual entry for offline actions.

## Risks / Trade-offs

Unrecognized or localized console formats can make a roster unavailable. Velocity's Maintenance add-by-name behavior depends on the installed release and may require the player to be online. The plugin can override the proxy's ping count while maintenance is active.
