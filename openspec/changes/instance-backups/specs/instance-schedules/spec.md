# Spec Delta

## Purpose

Extends per-instance schedule automation with a `backup` action that runs a backup plan, so backups reuse the existing trigger, limit, and access-control machinery.

## ADDED Requirements

### Requirement: Backup schedule action
The daemon SHALL support a schedule action type `backup` whose payload is the id of a backup plan that belongs to the same instance. When the action runs, the daemon SHALL enqueue that plan as a backup job through the backup queue and SHALL NOT wait for the job to finish before evaluating subsequent actions. A `backup` action whose plan does not exist, is disabled, or belongs to another instance SHALL be skipped and logged, and SHALL end the firing the same way any failing action does.

#### Scenario: Backup action enqueues a job
- **WHEN** a schedule containing a `backup` action with an existing plan id of the same instance fires
- **THEN** one backup job is queued for that plan and the schedule continues with its next action

#### Scenario: Foreign plan id is refused
- **WHEN** a `backup` action references a plan id that belongs to a different instance
- **THEN** no job is queued and the action is reported as failed

#### Scenario: Registration validates the payload
- **WHEN** a schedule is registered with a `backup` action whose payload is not a valid plan id string of the allowed format
- **THEN** the registration is rejected

### Requirement: Backup action access control
The panel SHALL allow registering a schedule that contains a `backup` action only for administrators. Regular users assigned to the instance MAY keep managing schedules that contain no `backup` action.

#### Scenario: Regular user cannot register a backup action
- **WHEN** a regular user registers a schedule containing a `backup` action
- **THEN** the request is rejected as forbidden and nothing is forwarded to the daemon
