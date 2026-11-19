# Spec Delta

## MODIFIED Requirements

### Requirement: Instance groups page
The Instances page SHALL offer a Normal view with the existing instance list and a Grouped view for every logged-in user. The browser SHALL remember the selected view when storage is available, and switching SHALL work when storage fails. The separate menu entry SHALL be removed and the legacy route SHALL open Instances in the Grouped view.

The Grouped view SHALL display the user's groups in group list order as horizontally scrollable columns that stack vertically on phones. Each group SHALL display its name, management controls, and members in their configured start order. Available members SHALL use the same instance cards as the Normal grid, with an additional Mini console action. Unavailable members SHALL appear muted with no actionable instance controls. The last column SHALL show available instances with no group membership. An instance assigned to multiple groups SHALL appear in each group. Mini consoles SHALL close when leaving Instances.

#### Scenario: Group columns and card order
- **WHEN** the Grouped view opens for a user with several groups and instances
- **THEN** columns appear in group list order, member cards appear in each group's start order, and Ungrouped shows only instances outside all groups

#### Scenario: Shared and unavailable members
- **WHEN** an instance belongs to more than one group or a stored member is unavailable
- **THEN** the shared instance appears in each of its groups and the unavailable member appears muted with no instance actions

#### Scenario: Only assigned instances can be picked
- **WHEN** a regular user opens the member picker
- **THEN** the picker lists only instances assigned to that user

#### Scenario: Buttons disabled during a run
- **WHEN** a group has an active run
- **THEN** its Start group and Stop group buttons are disabled, run progress is shown, and a cancel button is available

#### Scenario: The old link opens the board
- **WHEN** a logged-in user follows the old Instance groups URL
- **THEN** the Instances page opens with the Grouped view selected

#### Scenario: Storage is unavailable
- **WHEN** reading or writing the selected view in browser storage fails
- **THEN** the user can still switch between Normal and Grouped

#### Scenario: Mini consoles close on departure
- **WHEN** a user leaves the Instances page with mini consoles open
- **THEN** the consoles close and release their streams
