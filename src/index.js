require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  Collection,
  GatewayIntentBits,
  Events,
  MessageFlags,
  REST,
  Routes,
} = require('discord.js');
const { handleTicketInteraction } = require('./ticket-system');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[STARTUP] Missing ${key} environment variable.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
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

// Slash commands, ticket buttons, and ticket select menus.
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        console.warn(`[COMMAND] Discord sent /${interaction.commandName}, but it is not loaded locally.`);
        return;
      }

      await command.execute(interaction, client);
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

    console.log(`[STARTUP] Found ${commands.length} valid slash command(s).`);
    await registerCommands(commands);

    console.log('[STARTUP] Slash command registration complete. Logging in...');
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('[STARTUP ERROR]', error);
    process.exit(1);
  }
}

start();
