# Render Discord Ticket Bot

Node.js + discord.js v14 bot ready to deploy on Render.

## Ticket system included

- `/ticket-panel` posts an embed with a **Create Ticket** button.
- Tickets are created under category `1212792701423198229` by default.
- Ticket names are `ticket-1`, `ticket-2`, `ticket-3`, etc.
- The creator gets a private/ephemeral reply linking the new ticket channel.
- The ticket channel records the creator ID in its topic, so open tickets keep their creator information after a bot restart.
- New tickets contain **Close**, **Claim**, and **Role** buttons.
- **Claim** requires `Manage Messages` and updates the channel topic.
- **Role** requires `Manage Roles` and only lists roles that both the staff member and the bot are allowed to assign.
- Role menus paginate automatically if more than 25 valid roles are available.
- **Close** can be used by the ticket creator or a member with `Manage Messages`.

The bot preserves existing permission overwrites from the ticket category and additionally grants ticket access to the creator and staff roles with `Manage Messages`, `Manage Roles`, or `Administrator`.

## Discord bot permissions

Give the bot at least:

- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files
- Manage Channels
- Manage Messages
- Manage Roles

**Important:** move the bot's role above every role you want the Role button to be able to give. Discord does not allow a bot to assign roles that are at or above its highest role.

## Environment variables

Copy `.env.example` to `.env` for local use:

```env
DISCORD_TOKEN=...
CLIENT_ID=...
GUILD_ID=...
TICKET_CATEGORY_ID=1212792701423198229
```

`GUILD_ID` is recommended while testing because guild slash commands update quickly.

## Install and run

```bash
npm install
npm start
```

Then run `/ticket-panel` in the Discord channel where you want the ticket creation panel.

## Render

Use a **Background Worker**.

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

Add the environment variables above in Render.

The `npm start` command automatically registers slash commands before the bot logs in, so Render does not need a separate command-deployment step. During testing, keep `GUILD_ID` set so `/ticket-panel` appears quickly.

## Notes about ticket numbering

The bot checks existing `ticket-N` channels and also remembers the highest number while it is running. This prevents duplicate ticket numbers during normal operation and simultaneous button presses. Because Render's normal filesystem is not used for ticket state, open-ticket creator/claim data is stored in Discord itself (the channel topic).

If you later want ticket numbers to **never** be reused even after every old ticket is deleted and the bot is redeployed, add a database such as PostgreSQL for a permanent counter.

## Security

- Never upload `.env` to GitHub.
- Never put your bot token in source code.
- If the token is exposed, reset it in the Discord Developer Portal immediately.
