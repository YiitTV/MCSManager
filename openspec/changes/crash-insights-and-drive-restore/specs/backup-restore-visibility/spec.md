## Purpose

Help administrators find Drive copies and track the outcome of restores for an instance.

## ADDED Requirements

### Requirement: Google Drive restore
The backups page SHALL identify Google Drive copies and offer a Drive restore action to administrators when a usable Drive record exists. Restore requires a stopped instance and uses the existing backup job queue.

#### Scenario: Drive-only backup
- **WHEN** an administrator selects a Drive restore on a stopped instance with an available Drive copy
- **THEN** the job can restore directly from that copy without an existing local backup

#### Scenario: Regular user
- **WHEN** an assigned regular user views a Drive copy
- **THEN** the user can see the copy status and the administrator-only restore restriction applies

### Requirement: Restore status
The backups page SHALL display queued or running restore progress and the last available restore outcome to administrators.

#### Scenario: Restore completes between polls
- **WHEN** a restore completes before the next jobs request
- **THEN** the jobs response can still report success or sanitized failure for that restore
