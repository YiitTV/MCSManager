# Spec Delta

## Purpose

Defines admin-configured outbound notifications from the panel to a Discord bot endpoint or a Discord webhook: which events exist, how the admin selects them, how deliveries are signed, queued, retried, and bounded, and the safety rules for outbound requests and secrets.

## ADDED Requirements

### Requirement: Administrator-only notification settings
Only administrators SHALL be able to read or change notification settings, rotate the secret, or send a test notification. Regular users and unauthenticated callers MUST be refused. The settings SHALL be stored through the panel storage layer (`Storage.getStorage()`) in a record separate from the system configuration so the secret is never returned by other settings endpoints.

#### Scenario: Regular user is refused
- **WHEN** a regular user calls any notification settings endpoint
- **THEN** the panel returns a permission error and changes nothing

#### Scenario: Settings are persisted
- **WHEN** an administrator saves notification settings and the panel restarts
- **THEN** the same settings (except in-memory delivery statistics and queued events) are present after restart

### Requirement: Selectable event types
The panel SHALL support these event types, each with an independent on/off toggle that defaults to off: `instance.crashed`, `instance.started`, `instance.stopped`, `instance.auto_restarted`, `backup.succeeded`, `backup.failed`, `group.run_started`, `group.run_finished`, `group.run_failed`. The test event `notification.test` SHALL be sent on request regardless of the toggles.

#### Scenario: Disabled event type is not sent
- **WHEN** `instance.started` is off and an instance starts
- **THEN** no notification is queued for that start

#### Scenario: Enabled event type is sent
- **WHEN** `instance.crashed` is on and an instance process exits without a stop having been requested
- **THEN** exactly one `instance.crashed` notification is queued for that exit

#### Scenario: Notifications disabled
- **WHEN** notifications are disabled
- **THEN** no event is queued and no outbound request is made, and a test request returns a "not configured" result

### Requirement: Events are sent only when enabled
The panel SHALL send an event only when notifications are enabled, a sink is configured, and that event type's toggle is on.

#### Scenario: Toggle gate
- **WHEN** notifications are enabled but a type's toggle is off
- **THEN** events of that type are not sent

### Requirement: Instance lifecycle events from daemons
The daemon SHALL push a lifecycle message to the panel over its authenticated panel connection only, never to browser stream sockets. The panel SHALL map these messages to `instance.crashed`, `instance.stopped`, `instance.started`, and `instance.auto_restarted`.

#### Scenario: Unexpected exit is a crash
- **WHEN** a running instance process exits with code 3 without any stop request
- **THEN** the daemon reports a crash with exit code 3 and whether an automatic restart will follow

#### Scenario: Requested stop is not a crash
- **WHEN** a user stops a running instance and the process exits
- **THEN** the daemon reports a normal stop and no crash

#### Scenario: Daemon shutdown is not a crash
- **WHEN** the daemon is shutting down and its instances are terminated
- **THEN** no crash or stop notification is produced

#### Scenario: Auto-restart after a crash
- **WHEN** a crash is followed by an automatic restart that reaches the running state
- **THEN** the panel receives one auto-restart report with the attempt number and no separate started report for that start

#### Scenario: Browser stream sockets receive nothing
- **WHEN** a lifecycle message is pushed
- **THEN** only sockets that authenticated as the panel receive it

### Requirement: Crash classification
An exit SHALL be classified as a crash when no explicit stop, kill, or restart was requested and the daemon was not shutting down. An exit after an explicit stop, kill, or restart is a normal stop. A start performed by the automatic-restart feature SHALL be reported as an auto-restart and not additionally as a normal start.

#### Scenario: Classification input
- **WHEN** the daemon evaluates an exit
- **THEN** it uses the stop, kill, restart, and shutdown state known at the moment the process exited

### Requirement: Backup and group-run events from the panel
The panel SHALL expose an internal non-blocking emit function that backup and group-run code calls to submit `backup.succeeded`, `backup.failed`, `group.run_started`, `group.run_finished`, and `group.run_failed` events. Emitting MUST NOT throw and MUST NOT delay the caller. A cancelled group run SHALL produce `group.run_finished` with `details.result` equal to `cancelled`.

#### Scenario: Group run completes
- **WHEN** an ordered group start run finishes with all steps done or skipped
- **THEN** a `group.run_finished` event with `details.result` `succeeded` is queued if that toggle is on

#### Scenario: Emit never blocks
- **WHEN** the sink is down and the queue is full
- **THEN** the emitting code returns immediately and the instance or group operation is unaffected

### Requirement: Per-instance exclusion
The administrator SHALL be able to exclude instances from notifications by listing them in a bounded exclusion list (at most 200 entries). Events that carry an excluded instance (`instance.*` and `backup.*`) SHALL NOT be sent. Group-run events SHALL NOT be affected by the exclusion list.

#### Scenario: Excluded instance
- **WHEN** an instance is in the exclusion list and it crashes
- **THEN** no notification is queued

### Requirement: Versioned event payload
Each event SHALL be a JSON object with `version` (1), `id` (unique per event), `type`, `timestamp` (ISO 8601 UTC), `panel.name`, and `details`. Instance and backup events SHALL add `instance` (`daemonId`, `uuid`, `name`, optional `daemonName`); group events SHALL add `group` (`uuid`, `name`, `action`, `runId`); backup events SHALL add `backup`.

#### Scenario: Crash payload
- **WHEN** an instance crash is delivered to a bot endpoint
- **THEN** the body has `version` 1, type `instance.crashed`, the instance identifiers and name, and `details.exitCode` and `details.willAutoRestart`

#### Scenario: No sensitive data
- **WHEN** any event payload is produced
- **THEN** it contains no secret, credential, or absolute path

### Requirement: Payload content restrictions
Payloads MUST NOT contain secrets, passwords, API keys, tokens, or file system paths. String fields MUST be length-limited and the serialized body MUST NOT exceed 8 KB.

#### Scenario: Size limit
- **WHEN** a payload would exceed 8 KB
- **THEN** its string fields are truncated until it fits

### Requirement: Signed delivery to a bot endpoint
For the `bot_http` sink the panel SHALL POST the JSON body with `Content-Type: application/json`, `X-Minefield-Timestamp` (Unix seconds), and `X-Minefield-Signature: sha256=<lowercase hex>`. The signature SHALL be HMAC-SHA256, keyed with the shared secret, over the ASCII string `<timestamp>.` followed by the exact raw body bytes.

#### Scenario: Receiver verifies the signature
- **WHEN** a receiver recomputes HMAC-SHA256 over `<X-Minefield-Timestamp>.` plus the raw body with the shared secret
- **THEN** the result equals the header value and the delivery is accepted

#### Scenario: Retry carries a fresh signature
- **WHEN** a delivery is retried
- **THEN** the retry has the same event id, a new timestamp, and a signature valid for the new timestamp

### Requirement: Fresh signature on every attempt
Every attempt, including retries, SHALL carry a fresh timestamp and signature and the same event `id`. Receivers are expected to reject timestamps more than 300 seconds from their own clock.

#### Scenario: Receiver clock check
- **WHEN** a receiver gets a timestamp more than 300 seconds from its clock
- **THEN** it is expected to reject the request

### Requirement: Discord webhook sink
For the `discord_webhook` sink the panel SHALL POST a Discord message containing one embed per event, with mention parsing disabled (`allowed_mentions.parse` empty) and all field text truncated to Discord limits. The webhook URL MUST be an `https` URL on `discord.com`, `discordapp.com`, `canary.discord.com`, or `ptb.discord.com` with path `/api/webhooks/<id>/<token>`. This sink SHALL NOT be affected by the private-address option.

#### Scenario: Mentions are neutralised
- **WHEN** an instance name contains `@everyone`
- **THEN** the posted message does not ping anyone

#### Scenario: Non-Discord webhook host rejected
- **WHEN** the admin saves a `discord_webhook` URL on another host
- **THEN** the panel rejects the settings with a validation error

### Requirement: Shared secret management
For the `bot_http` sink the panel SHALL generate the shared secret (at least 32 random bytes, hex encoded) on request and SHALL return the plaintext only in the response that generates or rotates it. Afterwards, settings responses SHALL contain the placeholder `__MCSM_SECRET_DATA__`, and an update that sends the placeholder SHALL keep the stored value.

#### Scenario: Secret shown once
- **WHEN** an admin rotates the secret and later reads the settings
- **THEN** the rotate response contained the plaintext secret and the settings response contains only the masked placeholder

#### Scenario: Masked value preserved on save
- **WHEN** the frontend saves settings with the masked placeholder
- **THEN** the stored secret and webhook URL are unchanged

### Requirement: Webhook URL and secret never logged
The Discord webhook URL, which contains a token, SHALL be masked the same way. The secret and the webhook URL MUST NOT appear in logs, operation logs, or error messages.

#### Scenario: Logs
- **WHEN** a delivery fails
- **THEN** logs contain at most the host and an error code, never the secret or URL path

### Requirement: Outbound request safety
The panel SHALL validate the target URL when settings are saved and again before each delivery: length at most 512 characters, no embedded credentials, and scheme `https` (plain `http` only when "allow private address" is enabled and the host resolves to a private address).

#### Scenario: Private address refused
- **WHEN** the URL host resolves to `10.0.0.5` and "allow private address" is off
- **THEN** settings are rejected on save and any delivery attempt fails without a network connection

#### Scenario: DNS rebinding
- **WHEN** a hostname resolves to a public address at validation time and a private address on a later lookup
- **THEN** the delivery still connects only to the validated public address

#### Scenario: Redirect not followed
- **WHEN** the target answers with a redirect
- **THEN** the panel treats the response as a failed delivery and does not request the redirect location

#### Scenario: Private bot allowed explicitly
- **WHEN** the admin enables "allow private address" and sets `http://192.168.1.20:8080/hook`
- **THEN** the settings are accepted and deliveries are sent to that address

### Requirement: Request limits and logging
The panel MUST NOT follow redirects, MUST apply a 10 second timeout to each request, and MUST read at most 2 KB of the response. Logs MAY include the host and HTTP status but MUST NOT include the full URL or response body.

#### Scenario: Slow target
- **WHEN** the target does not answer within 10 seconds
- **THEN** the attempt fails with a timeout code

### Requirement: Address validation and pinning
Unless "allow private address" is enabled, the panel SHALL refuse hosts that resolve to loopback, private, link-local, carrier-grade NAT, multicast, reserved, or unspecified addresses (including IPv4-mapped IPv6), and SHALL connect to the exact validated address so a second DNS lookup cannot change the target.

#### Scenario: Public address
- **WHEN** the host resolves only to public addresses
- **THEN** the connection is made to that exact address

### Requirement: Bounded, non-blocking delivery
Events SHALL be delivered through an in-memory queue of at most 200 events processed by one worker. When the queue is full, the oldest event SHALL be dropped and counted. The queue SHALL NOT be persisted, so events still queued when the panel stops are lost. Notification handling MUST NOT delay or fail any instance, group, or backup operation.

#### Scenario: Transient failure then success
- **WHEN** the sink answers 503 once and then 204
- **THEN** the event is delivered on the second attempt and counted as sent

#### Scenario: Permanent client error
- **WHEN** the sink answers 401
- **THEN** the event is not retried, the delivery is recorded as failed, and the queue moves on

#### Scenario: Queue overflow
- **WHEN** the sink is unreachable and more than 200 events are queued
- **THEN** the oldest events are dropped and the dropped counter increases, memory stays bounded

### Requirement: Retry policy
A delivery that fails by network error, timeout, HTTP 5xx, 408, or 429 SHALL be retried up to three times after 5, 30, and 120 seconds (a 429 `Retry-After` is honoured up to 120 seconds). Other 4xx responses SHALL NOT be retried. A pending retry MUST NOT delay other ready events.

#### Scenario: Retry does not block
- **WHEN** one event waits for its retry time
- **THEN** other ready events are delivered meanwhile

### Requirement: Flood coalescing
The panel SHALL send at most 6 notifications per instance per rolling 60 seconds. Additional events for that instance in the window SHALL be dropped, and the number dropped SHALL be reported as `details.suppressedBefore` on the next event sent for that instance.

#### Scenario: Crash loop
- **WHEN** an instance crashes and auto-restarts 20 times within one minute
- **THEN** at most 6 notifications are sent in that minute and the next one reports how many were suppressed

### Requirement: Test notification and delivery status
The administrator SHALL be able to trigger a test notification that makes one delivery attempt (no retries) and returns the outcome (success or a short error code) to the caller. The settings view SHALL show the last delivery result (time, event type, success or error code) and counters for sent, failed, and dropped events since the panel started.

#### Scenario: Test succeeds
- **WHEN** the admin presses the test button and the sink answers 2xx
- **THEN** the response reports success and the last delivery status updates

#### Scenario: Test fails
- **WHEN** the sink is unreachable
- **THEN** the response reports failure with a short error code and no secret or full URL

### Requirement: Settings user interface
The administrator Settings page SHALL include a Notifications section with the enable switch, sink type, URL, secret controls (generate/rotate with one-time display), the "allow private address" switch (bot sink only) with a warning, one toggle per event type, the instance exclusion list, a test button, and the last delivery status. All text SHALL use the i18n mechanism.

#### Scenario: Secret displayed once
- **WHEN** the admin generates a secret
- **THEN** the UI shows it once with a copy control and later shows only a masked value

#### Scenario: Event toggles
- **WHEN** the admin turns individual event toggles on and saves
- **THEN** only those event types are sent afterwards
