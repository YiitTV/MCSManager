# Spec Delta

## Purpose

Warn players before manually restarting a network of game servers in a defined order.

## ADDED Requirements

### Requirement: Group restart warning settings
The group editor and API SHALL accept a group-specific warning template and 1 to 10 distinct whole-second offsets between 1 and 3600 seconds. Existing groups SHALL receive defaults of 300, 60, and 10 seconds and the template `Sunucu {seconds} saniye içinde yeniden başlatılıyor`.

#### Scenario: Group settings are saved
- **WHEN** the group owner saves valid settings
- **THEN** the panel persists the warning settings with the group

#### Scenario: Warning fields are bounded
- **WHEN** an owner submits malformed offsets or a message that is empty longer than 200 characters after sanitization, or contains shell operators
- **THEN** the panel rejects the update

### Requirement: Manual warned group restart
The board and group API SHALL let an authorized group owner launch a manual warned restart using the existing run limits. The panel SHALL check member authorization before dispatching commands, send warnings to running Paper and Purpur servers, save those servers before stopping the group, then stop and start members in the configured orders.

#### Scenario: Mixed server types
- **WHEN** the countdown reaches a warning offset in a group with running Paper, Purpur, and Velocity members
- **THEN** Paper and Purpur receive a single-line `say` message with the offset substituted
- **AND** Velocity receives no warning or save command and participates in ordered stop and start

#### Scenario: Cancel during countdown
- **WHEN** the owner cancels before the countdown ends
- **THEN** the countdown timer is cleared and no subsequent warnings or lifecycle steps are dispatched

#### Scenario: Assignment is revoked
- **WHEN** the owner loses access to a member before a command is dispatched
- **THEN** the panel fails the run without dispatching a command to that member
