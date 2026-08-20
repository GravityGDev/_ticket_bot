require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  Collection,
  GatewayIntentBits,
  Events,
  MessageFlags,
  Partials,
  REST,
  Routes,
} = require('discord.js');
const { handleTicketInteraction } = require('./ticket-system');
const {
  backfillOpenReportStaffTickets,
  trackReportStaffChannelCreate,
  trackReportStaffMessageCreate,
  trackReportStaffMessageUpdate,
  trackReportStaffMessageDelete,
  trackReportStaffMessageDeleteBulk,
  handleReportStaffChannelDelete,
} = require('./report-staff-tracker');
const { applySavedBotStatus } = require('./bot-status');
const {
  initializeStaffTracking,
  recordStaffActivityMessage,
} = require('./staff-tracking-store');
const { handleStaffTrackingInteraction } = require('./staff-tracking');
const {
  handleWarningInteraction,
  refreshWarningCountdowns,
} = require('./warn-system');
const {
  queueStaffGoalEvaluation,
  evaluateAllStaffGoals,
  processDueWarningRemovals,
} = require('./staff-settings');
const {
  authorizeApplicationCommand,
  initializeGuildPermissions,
  handleStaffPermissionInteraction,
} = require('./staff-command-permissions');

const {
  initializeSkinReview,
  handleSkinReviewInteraction,
  handleSkinReviewMessageCreate,
  handleSkinReviewMessageUpdate,
  handleSkinReviewMessageDelete,
  handleSkinReviewReactionAdd,
} = require('./skin-review');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[STARTUP] Missing ${key} environment variable.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // Needed so Report Staff can load the complete staff list and filter it
    // by the View Audit Log permission.
    GatewayIntentBits.GuildMembers,
    // Report Staff tickets are continuously archived so a manual channel
    // deletion cannot destroy the transcript.
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
  ],
});

client.commands = new Collection();

/**
 * Find every .js command file inside src/commands, including subfolders.
 * This means future command files are automatically loaded and registered
 * on the next bot restart/deploy.
 */
function getCommandFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...getCommandFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

function loadCommands() {
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = getCommandFiles(commandsPath);
  const commandPayload = [];

  client.commands.clear();

  for (const filePath of commandFiles) {
    // Clear cache so a process restart/reload always reads the latest file.
    delete require.cache[require.resolve(filePath)];
    const command = require(filePath);
    const relativePath = path.relative(__dirname, filePath);

    if (!command.data || typeof command.data.toJSON !== 'function') {
      console.warn(`[COMMAND] Skipping ${relativePath}: missing valid command.data.`);
      continue;
    }

    if (typeof command.execute !== 'function') {
      console.warn(`[COMMAND] Skipping ${relativePath}: missing command.execute.`);
      continue;
    }

    const json = command.data.toJSON();

    // Runtime access is controlled by the custom staff-role hierarchy.
    // Clear Discord's old Administrator / View Audit Log defaults so a lower
    // hierarchy role can actually invoke a command after the developer grants it.
    json.default_member_permissions = null;

    if (!json.name) {
      console.warn(`[COMMAND] Skipping ${relativePath}: command has no name.`);
      continue;
    }

    if (client.commands.has(json.name)) {
      console.warn(`[COMMAND] Duplicate /${json.name} found in ${relativePath}; skipping duplicate.`);
      continue;
    }

    client.commands.set(json.name, command);
    commandPayload.push(json);
    console.log(`[COMMAND] Loaded /${json.name} from ${relativePath}`);
  }

  return commandPayload;
}

async function registerCommands(commands) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  if (process.env.GUILD_ID) {
    console.log(
      `[COMMANDS] Registering ${commands.length} guild command(s) in ${process.env.GUILD_ID}...`,
    );

    const registered = await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID,
      ),
      { body: commands },
    );

    console.log(
      `[COMMANDS] Registered ${registered.length} guild command(s): ${
        registered.map((command) => `/${command.name}`).join(', ') || 'none'
      }`,
    );
    return;
  }

  console.log(
    `[COMMANDS] GUILD_ID is not set. Registering ${commands.length} global command(s)...`,
  );

  const registered = await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands },
  );

  console.log(
    `[COMMANDS] Registered ${registered.length} global command(s): ${
      registered.map((command) => `/${command.name}`).join(', ') || 'none'
    }`,
  );
}

// Load events.
const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith('.js'));

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);

    if (!event.name || !event.execute) {
      console.warn(`[EVENT] ${file} is missing name or execute.`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
  }
}

// Persistent Report Staff transcript tracking.
//
// These listeners continuously mirror Report Staff ticket messages to MongoDB.
// ChannelDelete then rebuilds the transcript from MongoDB, so even a manual
// Discord channel deletion cannot erase the ticket history.
client.on(Events.ChannelCreate, (channel) => {
  trackReportStaffChannelCreate(channel).catch((error) => {
    console.error('[REPORT STAFF CHANNEL CREATE TRACKER ERROR]', error);
  });
});

client.on(Events.MessageCreate, (message) => {
  trackReportStaffMessageCreate(message).catch((error) => {
    console.error('[REPORT STAFF MESSAGE CREATE TRACKER ERROR]', error);
  });
});

client.on(Events.MessageCreate, (message) => {
  handleSkinReviewMessageCreate(message).catch((error) => {
    console.error('[SKIN REVIEW MESSAGE CREATE ERROR]', error);
  });
});

client.on(Events.MessageCreate, (message) => {
  recordStaffActivityMessage(message)
    .then((recorded) => {
      if (recorded) {
        queueStaffGoalEvaluation(message.guild, message.author.id);
      }
    })
    .catch((error) => {
      console.error('[STAFF ACTIVITY TRACKER ERROR]', error);
    });
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  trackReportStaffMessageUpdate(oldMessage, newMessage).catch((error) => {
    console.error('[REPORT STAFF MESSAGE UPDATE TRACKER ERROR]', error);
  });
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  handleSkinReviewMessageUpdate(oldMessage, newMessage).catch((error) => {
    console.error('[SKIN REVIEW MESSAGE UPDATE ERROR]', error);
  });
});

client.on(Events.MessageDelete, (message) => {
  trackReportStaffMessageDelete(message).catch((error) => {
    console.error('[REPORT STAFF MESSAGE DELETE TRACKER ERROR]', error);
  });
});

client.on(Events.MessageDelete, (message) => {
  handleSkinReviewMessageDelete(message).catch((error) => {
    console.error('[SKIN REVIEW MESSAGE DELETE ERROR]', error);
  });
});

client.on(Events.MessageBulkDelete, (messages) => {
  trackReportStaffMessageDeleteBulk(messages).catch((error) => {
    console.error('[REPORT STAFF MESSAGE BULK DELETE TRACKER ERROR]', error);
  });
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  handleSkinReviewReactionAdd(reaction, user).catch((error) => {
    console.error('[SKIN REVIEW REACTION ADD ERROR]', error);
  });
});

client.on(Events.ChannelDelete, (channel) => {
  handleReportStaffChannelDelete(channel).catch((error) => {
    console.error('[REPORT STAFF CHANNEL DELETE ARCHIVE ERROR]', error);
  });
});

client.once(Events.ClientReady, (readyClient) => {
  // Backfill any Report Staff tickets that already existed when this update
  // was deployed, so their earlier visible history is copied into MongoDB too.
  backfillOpenReportStaffTickets(readyClient).catch((error) => {
    console.error('[REPORT STAFF BACKFILL ERROR]', error);
  });
});

client.once(Events.ClientReady, (readyClient) => {
  for (const guild of readyClient.guilds.cache.values()) {
    initializeGuildPermissions(guild).catch((error) => {
      console.error('[STAFF PERMISSIONS INITIALIZE ERROR]', error);
    });
  }
});

client.once(Events.ClientReady, (readyClient) => {
  applySavedBotStatus(readyClient).catch((error) => {
    console.error('[BOT STATUS RESTORE ERROR]', error);
  });
});

client.once(Events.ClientReady, () => {
  initializeStaffTracking().catch((error) => {
    console.error('[STAFF TRACKING INITIALIZE ERROR]', error);
  });
});

client.once(Events.ClientReady, (readyClient) => {
  initializeSkinReview(readyClient).catch((error) => {
    console.error('[SKIN REVIEW STARTUP ERROR]', error);
  });
});

client.once(Events.ClientReady, (readyClient) => {
  for (const guild of readyClient.guilds.cache.values()) {
    evaluateAllStaffGoals(guild).catch((error) => {
      console.error('[STAFF GOAL STARTUP EVALUATION ERROR]', error);
    });
  }

  const runWarningRemovalCheck = async () => {
    try {
      // Remove any warnings whose persisted MongoDB deadline has passed first.
      await processDueWarningRemovals(readyClient);

      // Then refresh every still-pending warning message from MongoDB.
      await refreshWarningCountdowns(readyClient);
    } catch (error) {
      console.error('[WARNING REMOVAL/COUNTDOWN SCHEDULER ERROR]', error);
    }
  };

  // Recover overdue jobs + warning countdown messages immediately on startup,
  // then keep them synced once per minute.
  runWarningRemovalCheck();
  const timer = setInterval(runWarningRemovalCheck, 60_000);
  timer.unref?.();
});

// Application commands, ticket buttons, and ticket select menus.
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (
      interaction.isChatInputCommand() ||
      interaction.isMessageContextMenuCommand()
    ) {
      const command =
        client.commands.get(
          interaction.commandName,
        );

      if (!command) {
        console.warn(
          `[COMMAND] Discord sent ${interaction.commandName}, but it is not loaded locally.`,
        );
        return;
      }

      if (
        !(await authorizeApplicationCommand(
          interaction,
        ))
      ) {
        return;
      }

      await command.execute(
        interaction,
        client,
      );
      return;
    }

    if (
      await handleStaffPermissionInteraction(
        interaction,
        client,
      )
    ) {
      return;
    }

    if (await handleSkinReviewInteraction(interaction, client)) {
      return;
    }

    if (await handleWarningInteraction(interaction)) {
      return;
    }

    if (await handleStaffTrackingInteraction(interaction)) {
      return;
    }

    await handleTicketInteraction(interaction);
  } catch (error) {
    console.error('[INTERACTION ERROR]', error);

    const response = {
      content: 'There was an error while handling that interaction.',
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(response).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (error) => {
  console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

async function start() {
  try {
    const commands = loadCommands();

    console.log(`[STARTUP] Found ${commands.length} valid application command(s).`);
    await registerCommands(commands);

    console.log('[STARTUP] Application command registration complete. Logging in...');
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('[STARTUP ERROR]', error);
    process.exit(1);
  }
}

start();
