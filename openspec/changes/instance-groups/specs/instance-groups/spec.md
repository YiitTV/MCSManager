# Spec Delta

## Purpose

Lets each user organise instances they may operate into named groups with an explicit start order and stop order, and start or stop a whole group in that order with readiness checks, timeouts, progress reporting, and strict per-instance authorisation.

## ADDED Requirements

### Requirement: Groups are owned by a single user
Each instance group SHALL belong to exactly one user. Listing, reading, updating, deleting, starting, stopping, and cancelling a group SHALL be allowed only to its owner. Administrators SHALL see and manage only their own groups, not other users' groups.

#### Scenario: Users see only their own groups
- **WHEN** user A has two groups and user B has one group, and user B lists groups
- **THEN** the response contains only user B's group

#### Scenario: Access to another user's group is refused
- **WHEN** user B requests update, delete, start, stop, or cancel for a group owned by user A
- **THEN** the panel responds with a not-found or forbidden error and changes nothing

#### Scenario: Administrator does not see other users' groups
- **WHEN** an administrator lists groups while a regular user owns groups
- **THEN** the response contains only groups owned by that administrator

### Requirement: Members must be instances the user may operate
A user SHALL be able to add an instance to a group only if the user is an administrator or the instance is assigned to that user. The panel SHALL validate every member (daemon id and instance uuid) against the user's assignments on create and on update, and SHALL ignore any display data sent by the client.

#### Scenario: Regular user adds an assigned instance
- **WHEN** a regular user creates a group containing an instance assigned to them
- **THEN** the group is created

#### Scenario: Regular user adds an unassigned instance
- **WHEN** a regular user creates or updates a group so that it contains an instance not assigned to them
- **THEN** the request is rejected with a forbidden error and no group data is stored

#### Scenario: Tampered identifiers are rejected
- **WHEN** a request contains a member with a non-string, empty, or oversized daemon id or instance uuid, a duplicate member, or an order list that is not a permutation of the members
- **THEN** the request is rejected with a validation error and nothing is stored

### Requirement: Group data model and limits
A group SHALL have a name of 1 to 40 characters, an ordered member list (the start order), a stop order that is a permutation of the members, and an advance configuration. A user SHALL own at most 20 groups, a group SHALL hold at most 30 members, and an instance SHALL appear at most once in a group.

#### Scenario: Group count limit
- **WHEN** a user who already owns 20 groups creates another group
- **THEN** the request is rejected with a limit error

#### Scenario: Member count limit
- **WHEN** a request would give a group 31 members
- **THEN** the request is rejected with a limit error

#### Scenario: Name validation
- **WHEN** a request has an empty name, or a name longer than 40 characters
- **THEN** the request is rejected with a validation error

### Requirement: Start order and stop order are independent
A group SHALL keep a start order and a separate stop order. Ordered start SHALL follow the start order and ordered stop SHALL follow the stop order. Adding a member SHALL append it to both orders, and removing a member SHALL remove it from both.

#### Scenario: Minecraft network ordering
- **WHEN** a group has start order Lobby, Main, Velocity and stop order Velocity, Main, Lobby, and the user starts and then stops the group
- **THEN** instances are started in the order Lobby, Main, Velocity and stopped in the order Velocity, Main, Lobby

#### Scenario: Reordering is persisted
- **WHEN** the owner changes the stop order and saves
- **THEN** a later read returns the new stop order and the start order is unchanged

### Requirement: Ordered start with configurable advance mode
Starting a group SHALL start its members one at a time in start order and SHALL advance only when the group's advance mode is satisfied: `pattern` (a console line from that instance matches the ready pattern), `running` (the instance reports running), or `delay` (a fixed number of seconds elapsed and the instance is still running). New groups SHALL default to `pattern` with `Done (*)!`.

#### Scenario: Ready pattern matched
- **WHEN** the mode is `pattern` with pattern `Done (*)!` and the instance prints `[Server thread/INFO]: Done (3.2s)! For help, type "help"`
- **THEN** the step completes and the next member is started

#### Scenario: Running status mode
- **WHEN** the mode is `running` and the instance reports status running
- **THEN** the step completes and the next member is started

#### Scenario: Fixed delay mode
- **WHEN** the mode is `delay` with 20 seconds and the instance is still running after 20 seconds
- **THEN** the step completes and the next member is started

#### Scenario: Instance exits during delay
- **WHEN** the mode is `delay` and the instance is no longer running when the delay ends
- **THEN** the step fails and the run stops

### Requirement: Members already in the target state are skipped
A member that is already running when a start step begins, or already stopped when a stop step begins, SHALL be skipped and counted as satisfied without sending a command.

#### Scenario: Already running member is skipped
- **WHEN** a member is already running when its step begins
- **THEN** the step is marked skipped as already running and the next member is processed without sending a start command

### Requirement: Timeouts stop the sequence
Every start wait and every stop wait SHALL have a timeout, configurable per group between 5 and 3600 seconds with a default of 180 seconds. When a wait times out, or the instance fails or exits while starting, the run SHALL stop, SHALL NOT start or stop any later members, and SHALL report the failed member and reason.

#### Scenario: Start timeout
- **WHEN** the ready pattern is never printed within the timeout
- **THEN** the run state becomes failed with reason timeout for that member and the remaining members stay untouched

#### Scenario: Instance fails while starting
- **WHEN** the instance reports failure or stops while the run is waiting for it
- **THEN** the run fails immediately instead of waiting for the timeout

#### Scenario: Timeout out of range
- **WHEN** a request sets a timeout below 5 or above 3600 seconds
- **THEN** the request is rejected with a validation error

### Requirement: Ordered stop waits for stopped without auto-kill
Stopping a group SHALL stop its members one at a time in stop order and SHALL advance only when the instance reports stopped. A member that is already stopped SHALL be skipped. On timeout the run SHALL fail and SHALL NOT kill the instance or stop later members.

#### Scenario: Stop sequence
- **WHEN** the owner stops a group whose members are running
- **THEN** each member receives a stop command only after the previous member has stopped

#### Scenario: Stop timeout does not kill
- **WHEN** an instance does not stop within the timeout
- **THEN** the run fails with reason timeout, no kill is issued, and later members keep running

### Requirement: Ready pattern is safe
The ready pattern SHALL be limited to 200 characters and SHALL support only literal text plus the `*` wildcard (any run of characters, at most 5 wildcards). Matching SHALL be case-sensitive, per console line, after ANSI escape sequences are removed, and SHALL run in time linear in the line length. Lines SHALL be truncated to 4096 characters before matching. Regular expressions SHALL NOT be accepted.

#### Scenario: Pattern too long or too many wildcards
- **WHEN** a request provides a pattern over 200 characters or with more than 5 wildcards
- **THEN** the request is rejected with a validation error

#### Scenario: Colour codes do not prevent a match
- **WHEN** the console line contains ANSI colour codes around the text `Done (1.5s)!`
- **THEN** the pattern `Done (*)!` matches

#### Scenario: Regex syntax is literal
- **WHEN** a pattern contains `(.+)+$`
- **THEN** it is matched as literal text and cannot cause backtracking

### Requirement: Every step is authorised against the owner
Before every start, stop, or event subscription for a member, the panel SHALL verify that the group owner still exists and is an administrator or still has the instance assigned. A member that fails the check SHALL be skipped and reported as not permitted, without any command being sent, and the run SHALL be marked failed. The client SHALL NOT supply the list of instances to operate; the panel SHALL use the stored group only.

#### Scenario: Instance unassigned after group creation
- **WHEN** a regular user starts a group that contains an instance an administrator has since unassigned from them
- **THEN** no start command is sent for that instance, its step is reported as not permitted, and the run stops as failed

#### Scenario: Unassignment during a run
- **WHEN** an instance is unassigned from the owner while a run is waiting on an earlier member
- **THEN** the later step for that instance is refused when it is reached

#### Scenario: Client cannot inject targets
- **WHEN** a start request includes a body listing extra instance uuids
- **THEN** the body is ignored and only the stored members are processed

#### Scenario: Group listing hides unauthorised members
- **WHEN** a regular user lists groups containing an instance no longer assigned to them
- **THEN** that member is returned as unavailable with no name or status

### Requirement: One active run per group
The panel SHALL allow only one active run (start or stop) per group at a time and SHALL allow at most 8 active runs panel-wide.

#### Scenario: Concurrent start is refused
- **WHEN** a start or stop is requested while that group already has an active run
- **THEN** the panel responds with a conflict error and the active run continues unaffected

#### Scenario: Global run cap
- **WHEN** 8 runs are active and a ninth is requested
- **THEN** the request is rejected with a busy error

### Requirement: Run progress and cancellation
The panel SHALL expose, for the owner, the state of the active or most recent run of a group: run id, action, overall state (`running`, `succeeded`, `failed`, `cancelled`), and a per-member step state (`pending`, `waiting`, `done`, `skipped`, `failed`) with a reason. The owner SHALL be able to cancel an active run; cancellation SHALL stop the sequence after the current wait without sending further commands. A finished run SHALL be kept in memory for at most 10 minutes.

#### Scenario: Progress is visible
- **WHEN** a run is waiting on the second of three members
- **THEN** the run status shows step one done, step two waiting, and step three pending

#### Scenario: Cancel a run
- **WHEN** the owner cancels an active run
- **THEN** the run becomes cancelled, no further members are started or stopped, and listeners and timers are released

#### Scenario: Panel restart during a run
- **WHEN** the panel restarts while a run is active
- **THEN** the run is not resumed, no run is reported for the group afterwards, and instances already started remain running

### Requirement: Run resources are bounded and released
A run SHALL use at most one daemon event connection and one timer at a time, SHALL NOT poll in a tight loop, and SHALL release its connection, listeners, and timers when the step ends, fails, times out, or is cancelled.

#### Scenario: Connection released after step
- **WHEN** a step completes
- **THEN** its daemon event connection is closed before the next step opens a new one

#### Scenario: Cleanup after failure
- **WHEN** a run fails on timeout
- **THEN** no listener or timer from that run remains registered

### Requirement: Group actions are logged
Group start and stop SHALL record the same operation-log entries as a single-instance start or stop for each command actually sent, attributed to the owner.

#### Scenario: Per-instance log entries
- **WHEN** a group start sends start commands to two instances
- **THEN** two instance start entries appear in the operation log for the owner

### Requirement: Instance groups page
The frontend SHALL provide an Instance groups page for every logged-in user that shows groups stacked vertically. Each group SHALL have a header with Start group and Stop group buttons, then one row per member with its name, status, and a control to open a mini console.

#### Scenario: Vertical layout
- **WHEN** a user with three groups opens the page
- **THEN** the three groups appear one under another, each with Start group and Stop group buttons at the top

#### Scenario: Only assigned instances can be picked
- **WHEN** a regular user opens the member picker
- **THEN** the picker lists only instances assigned to that user

#### Scenario: Buttons disabled during a run
- **WHEN** a group has an active run
- **THEN** its Start group and Stop group buttons are disabled and a cancel button is shown

### Requirement: Group management and run progress in the UI
The page SHALL let the owner create, rename, and delete groups, add or remove members, reorder start and stop order, and edit the advance mode, ready pattern, delay, and timeouts. While a run is active it SHALL show per-step progress and a cancel button, and SHALL poll the run no more often than every 2 seconds, only while the run is active.

#### Scenario: Progress polling stops
- **WHEN** a run reaches a terminal state
- **THEN** the page stops polling that run

#### Scenario: Reorder stop order
- **WHEN** the owner moves a member up in the stop order and saves
- **THEN** the page shows the new stop order and the start order is unchanged
