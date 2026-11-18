# Spec Delta

## Purpose

Provides small floating console windows that show live instance output and accept commands, so users can watch and control several instances at once without leaving the current page.

## ADDED Requirements

### Requirement: Open a mini console from an instance row
The frontend SHALL let a user open a mini console for an instance from the instance groups page. The mini console SHALL connect through the existing instance stream channel, which the panel authorises per instance, and SHALL show recent output followed by live output.

#### Scenario: Open for an assigned instance
- **WHEN** a user opens a mini console for an instance they may operate
- **THEN** a floating window appears showing the instance name, its recent output, and live output

#### Scenario: Unassigned instance is refused
- **WHEN** the stream channel request for an instance is refused as forbidden
- **THEN** the window shows an error state and no output stream is opened

### Requirement: Send commands from the mini console
The mini console SHALL provide an input that sends the typed line as a command to the instance through the instance stream, and SHALL disable the input when the instance is stopped.

#### Scenario: Send a command
- **WHEN** the user types `list` and presses Enter while the instance is running
- **THEN** the command is sent to that instance and its output appears in the window

#### Scenario: Instance stopped
- **WHEN** the instance is stopped
- **THEN** the input is disabled and the window indicates the stopped state

### Requirement: Floating, draggable, and minimisable windows
Mini consoles SHALL float above the page, SHALL be draggable by their title bar within the viewport, SHALL be minimisable to a title-bar-only state, and SHALL be closable. Several mini consoles SHALL be open at the same time, up to 4 per browser tab.

#### Scenario: Drag a window
- **WHEN** the user drags a mini console by its title bar
- **THEN** the window follows the pointer and stays within the viewport

#### Scenario: Minimise and restore
- **WHEN** the user minimises a mini console and later restores it
- **THEN** it collapses to its title bar and then expands with its output intact

#### Scenario: Window cap
- **WHEN** 4 mini consoles are open and the user opens a fifth
- **THEN** the fifth is not opened and the user is told to close one first

### Requirement: Bounded scrollback
Each mini console SHALL keep at most 1000 lines of scrollback in memory and SHALL discard older lines.

#### Scenario: Scrollback cap
- **WHEN** an instance prints 5000 lines while a mini console is open
- **THEN** the window retains only the most recent 1000 lines

### Requirement: Stream closed on close
Closing a mini console SHALL disconnect its stream, remove its listeners, and free its terminal resources. Leaving the page SHALL close all mini consoles.

#### Scenario: Close disconnects
- **WHEN** the user closes a mini console
- **THEN** its socket is disconnected and no further output is received for it

#### Scenario: Leaving the page
- **WHEN** the user navigates away from the instance groups page
- **THEN** every open mini console is closed and its stream disconnected
