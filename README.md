# Snay Ticket Tool

A full Discord ticketing, staff-management, moderation, warning-history, and staff-performance bot built with **Node.js**, **discord.js v14**, and **MongoDB**.

The bot is designed for the Snay.io Discord server and includes:

- Advanced ticket creation and management
- Multiple ticket types
- Claiming and assigning ticket roles
- Ticket transcripts
- Report Staff protection and backup system
- Staff performance tracking
- Staff ranks and activity scoring
- Warning roles with automatic removal
- Warning history
- Warning evidence uploads
- Revoke and Extend warning controls
- Staff goal rewards
- Warning removal scheduling
- Bot presence/status management
- MongoDB-backed persistent configuration
- Automatic slash-command registration

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Starting the Bot](#starting-the-bot)
- [Slash Commands](#slash-commands)
- [Ticket System](#ticket-system)
- [Ticket Types](#ticket-types)
- [Ticket Claiming](#ticket-claiming)
- [Ticket Closing](#ticket-closing)
- [Ticket Transcripts](#ticket-transcripts)
- [Report Staff System](#report-staff-system)
- [Muted Without Reason System](#muted-without-reason-system)
- [Staff Performance Tracking](#staff-performance-tracking)
- [Staff Stats Dashboard](#staff-stats-dashboard)
- [Staff Rank System](#staff-rank-system)
- [Warning System](#warning-system)
- [Warning Evidence](#warning-evidence)
- [Warning Removal](#warning-removal)
- [Revoke Warning](#revoke-warning)
- [Extend Warning](#extend-warning)
- [Warning History](#warning-history)
- [Staff Stats Settings](#staff-stats-settings)
- [Goal Rewards](#goal-rewards)
- [Warning Removal Scheduler](#warning-removal-scheduler)
- [Bot Status System](#bot-status-system)
- [MongoDB Collections](#mongodb-collections)
- [Important Discord Permissions](#important-discord-permissions)
- [Important Discord IDs](#important-discord-ids)
- [Render Deployment](#render-deployment)
- [Project Structure](#project-structure)
- [Security](#security)

---

# Requirements

Recommended:

- **Node.js 22+**
- **Node.js 24** works correctly on Render
- MongoDB / MongoDB Atlas
- Discord Bot Application
- Discord Server with the required permissions

Main packages:

```json
{
  "discord.js": "^14",
  "mongodb": "^7",
  "dotenv": "^16",
  "sharp": "^0.35.3"
}
```

---

# Installation

Clone the repository:

```bash
git clone https://github.com/GravityGDev/_ticket_bot.git
cd _ticket_bot
```

Install dependencies:

```bash
npm install
```

Create your environment variables.

Do **not** hard-code your Discord token or MongoDB URI inside the source code.

---

# Environment Variables

Required:

```env
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
CLIENT_ID=YOUR_DISCORD_APPLICATION_ID
MONGODB_URI=YOUR_MONGODB_CONNECTION_STRING
```

Optional:

```env
GUILD_ID=YOUR_TEST_OR_MAIN_SERVER_ID
MONGODB_DB_NAME=snay_ticket_bot
YOUTUBE_API_KEY=YOUR_YOUTUBE_DATA_API_KEY
```

## `GUILD_ID`

When `GUILD_ID` is set, slash commands are registered as guild commands.

This is useful during development because Discord updates guild commands almost immediately.

If `GUILD_ID` is not set, the bot registers commands globally.

---

# Starting the Bot

Run:

```bash
node src/index.js
```

The bot automatically:

1. Connects to MongoDB
2. Loads slash commands recursively from `src/commands`
3. Registers slash commands
4. Restores the saved bot presence
5. Starts staff tracking
6. Starts warning-removal scheduling
7. Restores pending warning timers from MongoDB
8. Backfills Report Staff ticket tracking
9. Starts ticket and interaction handlers

---

# Slash Commands

## `/ping`

Basic bot latency/status command.

---

## `/botinfo`

Displays information about the bot.

---

## `/ticket-panel`

Creates or configures the ticket panel.

The initial setup asks for:

- Ticket category
- Staff roles allowed to manage tickets

Use:

```text
/ticket-panel
```

To completely reconfigure:

```text
/ticket-panel reconfigure:true
```

Configuration is stored permanently in MongoDB.

---

## `/bot-status`

Administrator-only.

Changes the bot's Discord presence.

Supported activity types:

- Watching
- Playing
- Listening
- Competing
- Custom

The selected presence is stored in MongoDB and restored automatically after a restart.

---

## `/staff-stats`

Displays the staff performance dashboard.

Available to staff with **View Audit Log** permission.

Features include:

- Weekly stats
- Monthly stats
- Quarterly stats
- Ticket claims
- Tracked staff messages
- Staff leaderboard
- Staff details
- Warning status
- Star roles
- Staff filters
- Best active staff
- Admin settings for authorized editors

---

## `/rank`

Displays a generated PNG staff rank card.

Usage:

```text
/rank
```

View another staff member:

```text
/rank staff:@User
```

Optional periods:

- Lifetime
- Weekly
- Monthly
- Quarterly

Example:

```text
/rank staff:@Harry period:monthly
```

The card includes:

- Avatar
- Display name
- Username
- Rank
- Performance level
- XP
- Tickets claimed
- Tracked messages
- Activity score
- Star status
- Warning status

Hidden staff members display:

```text
RANK HIDDEN
```

instead of a numbered rank.

---

## `/warn`

Administrator-only.

Creates a staff warning and schedules automatic warning-role removal.

The command supports:

- Staff member
- Warning reason
- Warning role
- Removal duration
- Custom date/time
- Evidence images

Example:

```text
/warn staff:@User reason:"Failure to follow staff procedure" warning-role:"Warning 1" remove-in:"7 days" evidence-1:<image>
```

---

## `/warnings`

Displays the full warning history for a staff member.

Usage:

```text
/warnings staff:@User
```

Shows **5 warnings per page**.

Use the:

```text
⬅️  ➡️
```

buttons to switch pages.

Staff Stats Settings Editors receive additional history-management controls.

---

# Ticket System

Tickets are created using the main ticket panel.

Ticket configuration is stored in MongoDB.

The ticket type menu is generated dynamically whenever a user presses **Create Ticket**.

This means ticket types can be updated without recreating the main ticket panel.

Ticket names use:

```text
ticket-{number}_{ticket-type}
```

Closed tickets use:

```text
closed-{number}_{ticket-type}
```

Example:

```text
ticket-154_report-staff
```

Ticket numbers are permanent and never reused.

The counter is stored atomically in MongoDB.

---

# Ticket Types

Current ticket types include:

### General Inquiry

General support ticket.

The user can type immediately and explain what they need help with.

---

### Bug Report

For reporting bugs or technical issues.

---

### Cheating Report

For reporting suspected cheating.

---

### Muted Without Reason?

For users who believe they were incorrectly muted.

Requires an in-game ID before the user can continue.

---

### Report Staff

Used to report members of staff.

Has additional security and transcript protection.

---

### Claim Reward

Used to claim an eligible reward.

Requires an in-game ID.

---

### Booster Claim

For Discord booster rewards.

Requires an in-game ID.

---

### YouTuber Submission

Used for creator / YouTube submissions.

Can optionally use the YouTube Data API when `YOUTUBE_API_KEY` is configured.

---

### Clan Skin / Badge Refund

Used to request refunds relating to clan skins or badges.

---

### Account Issues

Used for account-related support.

---

### Payment Issues

Used for payment-related support.

---

# Ticket Claiming

Normal tickets include:

```text
Close
Claim
Role
```

## Claim

Requires staff with **Manage Messages**.

When claimed:

- Claimer is stored in MongoDB
- Ticket state records who claimed it
- Staff ticket-claim stats increase
- The claim permanently contributes to staff performance statistics

Claims are stored in:

```text
staff_ticket_claims
```

Each ticket channel can only count once.

---

# Ticket Role Assignment

The **Role** button allows authorized staff to assign configured ticket roles to the ticket creator.

Only roles selected during ticket setup can be used.

The bot validates Discord role hierarchy before assigning a role.

The bot must have:

```text
Manage Roles
```

and its highest role must be above the roles it needs to assign.

---

# Ticket Closing

When a ticket is closed:

- The ticket creator immediately loses access
- Administrators can still view the channel
- Ticket controls change
- The channel is renamed when Discord rate limits allow it

Closed ticket controls include:

```text
Transcript
Open
Delete
```

## Open

Reopens the ticket and restores the correct permissions.

## Delete

Starts a 5-second deletion process.

A final transcript is generated before deletion.

If transcript logging fails, deletion is aborted to protect ticket history.

---

# Ticket Transcripts

Ticket transcripts are generated as signed HTML files.

All genuine ticket channels are continuously archived in the existing `report_staff_archives` and `report_staff_messages` collections, including normal tickets. Existing tickets are backfilled at startup. This preserves messages and edit history for manual deletion recovery without creating more MongoDB collections.

Final deletion transcripts show the deleting user's name and ID, deletion method (Delete button, manual channel deletion, or automation), and deletion time. Button deletion records the person who clicked Delete after Discord confirms deletion, rather than attributing it to the bot. Manual deletion requires the bot's **View Audit Log** permission; unavailable audit information is shown as **Unknown**.

Button deletion creates a safety archive before removing the channel, followed by a final deletion transcript with confirmed deletion details. Normal final transcripts go to the ticket log channel. Report Staff final transcripts retain their security-recipient and creator DM backups. A failed safety archive cancels button deletion; failed final delivery retains the messages and deletion metadata in MongoDB.

Set `TRANSCRIPT_SIGNING_SECRET` to a private value of at least 32 characters in Dokploy. Keep the same secret to verify older transcripts. New integrity records use namespaced documents in the existing `bot_settings` collection; old integrity records remain readable by `/verify-transcript`.

Messages already deleted before they were tracked cannot be recovered. Let startup backfill finish before manually deleting existing tickets.

Transcript contents include:

- Messages
- Usernames
- Avatars
- Timestamps
- Message content
- Embeds
- Attachments

The final transcript log includes:

- Ticket Owner
- Claimed By
- Ticket type
- Ticket information

For claimed tickets:

```text
Claimed By: @StaffMember
```

For unclaimed tickets:

```text
Claimed By: Unclaimed
```

---

# Report Staff System

Report Staff tickets use additional security.

Dedicated Report Staff category:

```text
1194859845426364497
```

When the user creates a Report Staff ticket:

1. The user selects the staff member they are reporting
2. The selected staff member is added to the ticket
3. Both parties are mentioned
4. The reporter is asked to provide evidence

The staff selector only includes:

- Non-bot members
- Members with **View Audit Log**

The selector supports pagination.

---

## Report Staff Restrictions

Report Staff tickets only display the **Close** button.

They do not use:

- Claim
- Role

Only Discord Administrators can:

- Close
- Reopen
- Delete

If the reported member is an Administrator, they cannot use the bot to close their own report.

---

# Report Staff Transcript Protection

Report Staff messages are continuously mirrored into MongoDB.

This protects the evidence even if an Administrator manually deletes the Discord ticket channel.

Tracked information includes:

- Author
- Message content
- Timestamp
- Attachments
- Embeds
- Stickers
- Edit history
- Deleted state

Collections:

```text
report_staff_archives
report_staff_messages
```

When a Report Staff channel is manually deleted:

1. The bot reconstructs the transcript from MongoDB
2. The security recipient receives a DM copy
3. The ticket creator receives a backup copy
4. The bot attempts to identify the channel deleter using Discord Audit Logs

If DMs fail, the MongoDB archive remains.

---

# Muted Without Reason System

The user must first submit their in-game ID.

After the ID is submitted:

- The user is allowed to provide evidence
- They can optionally select the suspected staff member
- The selected staff member is only recorded
- The selected staff member is **not** automatically added or pinged

Controls:

```text
Close
Approved Unmute
Reject Unmute
```

The decision requires **Manage Messages**.

Only one final decision can be made.

## Approved Unmute

The creator is informed that the mute was not justified and should be removed.

## Reject Unmute

The creator is informed that the mute was considered valid.

---

# Staff Performance Tracking

Staff tracking is based on members with:

```text
View Audit Log
```

Tracked ticket claim data is stored permanently.

Tracked staff messages store metadata only.

Message content is **not** stored for normal staff activity tracking.

Tracked message documents include:

- Staff ID
- Category ID
- Channel ID
- Channel name
- Message ID
- Timestamp

Collection:

```text
staff_activity_messages
```

---

# Staff Tracking Categories

Tracking categories are configurable through Staff Stats Admin Settings.

Previously configured categories include:

```text
1194039775787745531
1292633562390069281
1212792701423198229
```

Tracking rule:

```text
Member has View Audit Log
AND
Channel is not blacklisted
AND
(
    Channel parent is tracked
    OR
    Channel is explicitly whitelisted
)
```

---

# Staff Stats Dashboard

The staff dashboard supports:

### Periods

- Weekly — rolling 7 days
- Monthly — rolling 30 days
- Quarterly — rolling 90 days

`/rank` also supports Lifetime.

---

## Leaderboard Ordering

Normal leaderboard ranking uses:

1. Tickets claimed
2. Tracked messages as the tie-breaker

The leaderboard is paginated with 10 staff per page.

---

# Staff Filters

Available filters include:

### All Staff

Everyone with **View Audit Log** permission.

### Star Management

Only staff with ⭐ or ⭐⭐ roles.

### Warning Roles

Staff currently holding a warning role.

### No Warning Roles

Staff without warning roles.

### Active Star Staff

⭐ / ⭐⭐ staff with activity during the selected period.

---

# Star Roles

Star-role badges:

```text
955029841793650688 = ⭐
955030166797713408 = ⭐⭐
```

The two-star role has priority.

Star roles are display badges only.

They do not automatically make someone the best active staff member.

---

# Best Active Staff

Best Active Staff considers all active, non-hidden staff.

Activity score:

```text
Ticket Claims × Ticket Claim Points
+
Tracked Messages × Tracked Message Points
```

Default values:

```text
Ticket Claim = 100 points
Tracked Message = 1 point
```

These values are configurable in Staff Stats Admin Settings.

---

# Hidden Staff

Authorized Staff Stats editors can hide selected staff from leaderboard ranking.

Hidden staff:

- Still have activity tracked
- Still retain their database stats
- Do not appear on leaderboards
- Do not affect other staff rank positions
- Display `RANK HIDDEN` on `/rank`

---

# Staff Rank System

Performance XP uses the configurable activity points.

Level progression starts with:

```text
Level 1 requirement: 500 XP
```

Each following level requires:

```text
+150 XP
```

The rank card is generated using:

```text
sharp
```

---

# Warning System

The warning system is fully backed by MongoDB.

Allowed warning roles:

```text
961199921841713162
961199596212744252
```

The slash command only allows these two roles.

---

# Warning Evidence

At least **one evidence image is required** when issuing a warning.

Available slash-command attachment fields:

```text
evidence-1  REQUIRED
evidence-2  optional
evidence-3  optional
evidence-4  optional
evidence-5  optional
```

Supported image formats:

- PNG
- JPG
- JPEG
- GIF
- WEBP

The bot re-uploads the images to the warning message.

The message displays:

```text
**Evidence:**
```

followed by the evidence images.

Evidence stays attached when the warning is:

- Extended
- Revoked
- Automatically removed

Evidence metadata is also stored in MongoDB.

---

# Warning Message

A warning embed includes:

- Staff member
- Warning role
- Issued by
- Reason
- Warning History count
- Automatic Removal date
- Evidence

Example:

```text
⚠️ Staff Warning

@StaffMember has received a staff warning.

Warning Role
@Warning 1

Issued By
@Administrator

Reason
Failure to follow staff procedure

Warning History
3 warnings on record

Automatic Removal
19 August 2026 20:30
```

There is no separate user ping above the warning embed.

---

# Warning Removal Time

Standard removal choices include:

- 30 minutes
- 1 hour
- 6 hours
- 12 hours
- 1 day
- 3 days
- 7 days
- 14 days
- 30 days
- Custom date/time

---

# Custom Warning Date / Time

Custom warning date/time uses UK time:

```text
Europe/London
```

The command supports:

- Year
- Month
- Day
- Hour
- Minute

Hour uses 24-hour time:

```text
0 - 23
```

Examples:

```text
1  = 01:00
13 = 13:00
20 = 20:00
23 = 23:00
```

---

## Smart Custom Defaults

If a field is left blank:

```text
year blank   → current UK year
month blank  → current UK month
day blank    → current UK day
hour blank   → current UK hour
minute blank → 5 minutes from now
```

The system handles:

- BST
- GMT
- Day rollover
- Month rollover
- New Year rollover
- Leap years

The final warning-removal time must still be in the future.

---

# Warning Removal

Every active warning stores:

- Guild ID
- Staff user ID
- Warning role ID
- Removal date
- Reason
- Issuing administrator
- Discord channel ID
- Discord message ID
- Evidence
- Status

The removal scheduler checks MongoDB regularly.

Because the deadline is stored in MongoDB, warning removal survives:

- Render restarts
- Bot restarts
- Redeploys

---

# Automatic Warning Removal

When the warning reaches its stored date/time:

1. The warning role is removed
2. MongoDB marks the warning as completed
3. The original warning message is updated
4. The embed title changes to:

```text
✅ Warning Removed
```

5. The embed shows that the warning was automatically removed
6. The **Revoke** and **Extend** buttons are removed
7. Evidence remains attached to the warning message

---

# Revoke Warning

Active warnings include:

```text
🗑️ Revoke
```

Only Administrators can use it.

Pressing Revoke opens a required form:

```text
Reason for revoking this warning
```

After submission:

- Warning role is immediately removed
- Scheduled removal is cancelled
- Revoke reason is stored
- Revoking admin is stored
- Revocation time is stored
- Original warning embed changes to:

```text
✅ Warning Revoked
```

- Revoke reason is displayed
- Buttons are removed

---

# Extend Warning

Active warnings include:

```text
⏰ Extend
```

Only Administrators can use it.

Available extension choices:

- +30 minutes
- +1 hour
- +6 hours
- +12 hours
- +1 day
- +3 days
- +7 days
- +14 days
- +30 days

After selecting an extension, the bot opens a required form:

```text
Reason for extending this warning
```

After submission:

- Time is added to the current removal date
- MongoDB deadline is updated
- Extension reason is stored
- Extending admin is stored
- Extension amount is stored
- Extension history is stored

The original warning embed gets:

```text
Latest Extension

Extended by: @Administrator
Time added: 7 days
Reason: Staff member requires further monitoring
New removal: <date>
```

---

# Warning History

Every warning contributes to the staff member's tracked warning history.

The current total is displayed in each warning embed.

Example:

```text
Warning History
4 warnings on record
```

History survives:

- Warning expiry
- Warning revocation
- Bot restart
- Render redeploy

---

# `/warnings`

Use:

```text
/warnings staff:@User
```

The command shows:

- Total warning count
- Warning status
- Warning role
- Issued date
- Issued by
- Original warning reason
- Evidence links
- Scheduled removal date
- Automatic removal date
- Revoke information
- Revoke reason
- Extension information
- Extension reason
- Removal failures

Only **5 warnings are displayed per page**.

Navigation:

```text
⬅️  Page X/Y  ➡️
```

---

# Warning History Management

Staff Stats Settings Editors receive additional controls inside `/warnings`.

Editors can:

### Remove one warning

Select a warning from the current page and confirm:

```text
Remove This Warning
```

### Remove all warning history

Use:

```text
Remove All History
```

and confirm the action.

---

## History Removal Safety

Removing a warning from tracked history is a **soft history removal**.

If the warning is still active:

- The warning role remains
- Automatic removal continues
- Revoke still works
- Extend still works
- The Discord warning message stays active

Only the `/warnings` history record is hidden.

This prevents an active warning role becoming permanently stuck because someone deleted its tracking record.

---

# Staff Stats Settings

The Admin Settings system is available to:

- Bot owner
- Whitelisted Settings Editors

Normal staff can view Staff Stats but cannot access settings.

---

# Settings Editors

The bot owner can whitelist staff as Settings Editors.

Editors must:

- Be current server members
- Have **View Audit Log**
- Not be bots

Editors can manage Staff Stats configuration.

Only the owner can manage the editor list.

---

# Tracking Categories

Editors can configure:

- Tracked categories
- Channel blacklist
- Channel whitelist

---

# Performance Points

Editors can configure:

```text
Points per ticket claim
Points per tracked message
```

Allowed values:

```text
0 - 1,000,000
```

These values affect:

- Best Active Staff
- `/rank` activity score
- Performance XP
- Level progression

---

# Goal Rewards

Authorized editors can create staff activity rewards.

Each goal contains:

- Goal name
- Metric
- Threshold
- Reward role
- Period

Supported metrics:

```text
tickets
messages
```

Supported periods:

```text
lifetime
weekly
monthly
quarterly
```

When a staff member reaches the goal, the configured role is awarded.

The bot checks goals after:

- Ticket claims
- Tracked messages
- Goal creation
- Goal editing
- Bot startup

---

# Warning Removal Scheduler

Staff Stats settings can also schedule warning-role removals.

A schedule contains:

- Staff member
- Warning role
- Date/time
- Reason

UK date/time is interpreted using:

```text
Europe/London
```

The scheduler:

- Runs regularly
- Processes overdue jobs after restart
- Recovers jobs interrupted during deploy
- Removes the correct role
- Marks the MongoDB job complete

---

# Important Discord Permissions

The bot should have:

```text
View Channels
Send Messages
Embed Links
Attach Files
Read Message History
Manage Channels
Manage Roles
Manage Messages
View Audit Log
```

For full functionality, the bot role must be high enough in the Discord role hierarchy.

---

## Privileged Intents

Enable these in the Discord Developer Portal:

### Server Members Intent

Required for:

- Staff selectors
- Report Staff
- Staff filtering
- Role/staff checks

### Message Content Intent

Required for:

- Report Staff transcript protection
- Persistent Report Staff message archiving

---

# Important Discord IDs

## Report Staff category

```text
1194859845426364497
```

## Ticket / staff tracking category

```text
1212792701423198229
```

## Transcript log channel

```text
1538580589542777055
```

## Warning roles

```text
961199921841713162
961199596212744252
```

## Star roles

```text
955029841793650688 = ⭐
955030166797713408 = ⭐⭐
```

## Staff warning roles used by Staff Stats

```text
961199921841713162
961199596212744252
```

---

# MongoDB Collections

The bot uses multiple MongoDB collections.

Important collections include:

```text
server_configs
server_stats
ticket_states
staff_ticket_claims
staff_activity_messages
staff_tracking_settings
staff_goals
staff_goal_grants
staff_warning_removals
bot_settings
report_staff_archives
report_staff_messages
```

The exact collection names may vary slightly depending on the current store module, but all persistent systems use MongoDB.

---

# Ticket Counter

Ticket numbers are stored in MongoDB.

The number increases permanently.

Deleting a ticket does not reduce or reuse its number.

Example:

```text
ticket-101
ticket-102
ticket-103
```

If ticket 102 is deleted, the next ticket is still:

```text
ticket-104
```

---

# Render Deployment

Recommended Render service:

```text
Background Worker
```

Start command:

```bash
node src/index.js
```

Set environment variables through the Render dashboard.

Example:

```env
DISCORD_TOKEN=...
CLIENT_ID=...
MONGODB_URI=...
MONGODB_DB_NAME=snay_ticket_bot
GUILD_ID=...
YOUTUBE_API_KEY=...
```

Never commit secrets to GitHub.

---

# Automatic Command Registration

You do not need a separate deploy-commands script.

`src/index.js` recursively loads command files from:

```text
src/commands/
```

Every `.js` command with:

```js
module.exports = {
  data,
  execute
}
```

is automatically loaded.

On startup the bot registers the command using Discord REST API v10.

---

# Project Structure

Example:

```text
src/
├── commands/
│   ├── ping.js
│   ├── botinfo.js
│   ├── ticket-panel.js
│   ├── bot-status.js
│   ├── staff-stats.js
│   ├── rank.js
│   ├── warn.js
│   └── warnings.js
│
├── index.js
├── database.js
├── config-store.js
├── ticket-store.js
├── ticket-counter-store.js
├── ticket-system.js
├── transcript.js
├── report-staff-tracker.js
├── staff-tracking.js
├── staff-tracking-store.js
├── staff-rank.js
├── staff-settings.js
├── staff-settings-store.js
├── warn-system.js
└── bot-status.js
```

The exact file layout may expand as new features are added.

---

# Security

Never commit:

```text
Discord bot tokens
MongoDB usernames
MongoDB passwords
MongoDB connection strings
YouTube API keys
```

Keep secrets in environment variables.

Recommended `.gitignore`:

```gitignore
node_modules/
.env
.env.*
*.log
```

Do not expose your `.env` file in screenshots, GitHub commits, logs, or support messages.

---

# Error Logging

Major systems use prefixed console errors such as:

```text
[WARN COMMAND ERROR]
[STAFF WARNING INTERACTION ERROR]
[WARNING REMOVAL SCHEDULER ERROR]
[REPORT STAFF BACKFILL ERROR]
[STAFF ACTIVITY TRACKER ERROR]
```

These logs are useful when diagnosing Render deployment problems.

---

# Notes

The bot is designed around persistent MongoDB state.

Important systems such as:

- Ticket numbering
- Ticket claims
- Staff activity
- Staff ranks
- Warnings
- Warning evidence
- Warning history
- Warning removal
- Warning extensions
- Warning revocations
- Report Staff transcripts
- Bot presence
- Staff settings

remain available after bot restarts or redeploys.

---

# Snay Ticket Tool

Built for the Snay.io Discord community.

Discord bot powered by:

- Node.js
- discord.js
- MongoDB
- Sharp


### Delete button permissions

In `/permissions`, select **Delete normal tickets (button)** or **Delete Report Staff tickets (button)**, then choose the minimum staff role or **Developer only**. The selected role and higher hierarchy roles receive access. Settings persist across restarts. **Reset** restores the previous defaults: the designated normal-ticket deletion role, or Discord Administrator for Report Staff. The bot developer retains access, and the reported person cannot delete their own Report Staff ticket.

These settings control bot Delete buttons. Discord's Manage Channels permission still controls manual channel deletion.
