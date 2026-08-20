const {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const {
  getMongoDb,
} = require('./database');
const {
  STAFF_ROLE_IDS,
  getHighestStaffRoleIndex,
  isBotDeveloper,
  roleLevelNumber,
} = require('./staff-role-hierarchy');

const COLLECTION_NAME =
  'staff_command_permissions';

const COMMANDS_PER_PAGE = 20;

// null = developer only.
// 0..8 = minimum hierarchy role index.
const DEFAULT_MINIMUM_ROLE = Object.freeze({
  // Staff defaults.
  'chat:help': 0,
  'chat:ping': 0,
  'chat:rank': 0,
  'chat:team': 0,
  'chat:search': 0,
  'message:Search Associated Media': 0,

  // Previous "admin" command group defaults to the highest staff role.
  'chat:staff-stats': 8,
  'chat:ticket-panel': 8,
  'chat:verify-transcript': 8,
  'chat:warn': 8,
  'chat:warnings': 8,
  'chat:bot-status': 8,
  'chat:botinfo': 8,

  // The editor itself can never be delegated.
  'chat:permissions': null,
});

// Unknown future commands default to the highest staff role until the
// developer explicitly changes them in /permissions.
const UNKNOWN_COMMAND_DEFAULT = 8;

const permissionCache = new Map();
const loadedGuilds = new Set();

function commandTypePrefix(type) {
  if (
    type ===
    ApplicationCommandType.Message
  ) {
    return 'message';
  }

  if (
    type ===
    ApplicationCommandType.User
  ) {
    return 'user';
  }

  return 'chat';
}

function commandKeyFromJson(json) {
  return (
    `${commandTypePrefix(json?.type)}:` +
    `${String(json?.name || '')}`
  );
}

function commandKeyFromInteraction(
  interaction,
) {
  if (
    interaction.isMessageContextMenuCommand?.()
  ) {
    return (
      `message:${interaction.commandName}`
    );
  }

  if (
    interaction.isUserContextMenuCommand?.()
  ) {
    return (
      `user:${interaction.commandName}`
    );
  }

  return (
    `chat:${interaction.commandName}`
  );
}

function commandDisplayName(
  commandKey,
) {
  const [type, ...parts] =
    String(commandKey).split(':');

  const name =
    parts.join(':');

  if (type === 'message') {
    return `Apps: ${name}`;
  }

  if (type === 'user') {
    return `Apps: ${name}`;
  }

  return `/${name}`;
}

function commandDescriptionFromClient(
  client,
  commandKey,
) {
  for (const command of client.commands.values()) {
    const json =
      command?.data?.toJSON?.();

    if (
      json &&
      commandKeyFromJson(json) ===
        commandKey
    ) {
      return (
        String(
          json.description ||
          'Application command',
        )
      );
    }
  }

  return 'Application command';
}

function defaultMinimumRole(
  commandKey,
) {
  if (
    Object.prototype.hasOwnProperty.call(
      DEFAULT_MINIMUM_ROLE,
      commandKey,
    )
  ) {
    return DEFAULT_MINIMUM_ROLE[
      commandKey
    ];
  }

  return UNKNOWN_COMMAND_DEFAULT;
}

function ensureGuildCache(guildId) {
  const key =
    String(guildId);

  if (
    !permissionCache.has(key)
  ) {
    permissionCache.set(
      key,
      new Map(),
    );
  }

  return permissionCache.get(key);
}

async function loadGuildCommandPermissions(
  guildId,
  {
    force = false,
  } = {},
) {
  const guildKey =
    String(guildId);

  if (
    loadedGuilds.has(guildKey) &&
    !force
  ) {
    return ensureGuildCache(
      guildKey,
    );
  }

  const db =
    await getMongoDb();

  const rows =
    await db
      .collection(
        COLLECTION_NAME,
      )
      .find({
        guildId: guildKey,
      })
      .toArray();

  const cache =
    ensureGuildCache(
      guildKey,
    );

  cache.clear();

  for (const row of rows) {
    cache.set(
      String(
        row.commandKey,
      ),
      row.minRoleIndex === null
        ? null
        : Number(
            row.minRoleIndex,
          ),
    );
  }

  loadedGuilds.add(
    guildKey,
  );

  return cache;
}

function getMinimumRoleSync(
  guildId,
  commandKey,
) {
  const cache =
    ensureGuildCache(
      guildId,
    );

  if (
    cache.has(
      commandKey,
    )
  ) {
    return cache.get(
      commandKey,
    );
  }

  return defaultMinimumRole(
    commandKey,
  );
}

async function getMinimumRole(
  guildId,
  commandKey,
) {
  await loadGuildCommandPermissions(
    guildId,
  );

  return getMinimumRoleSync(
    guildId,
    commandKey,
  );
}

function canMemberUseCommandSync(
  member,
  commandKey,
) {
  if (!member) return false;

  if (
    isBotDeveloper(
      member,
    )
  ) {
    return true;
  }

  const minimum =
    getMinimumRoleSync(
      member.guild.id,
      commandKey,
    );

  if (minimum === null) {
    return false;
  }

  const memberLevel =
    getHighestStaffRoleIndex(
      member,
    );

  return (
    memberLevel >= minimum
  );
}

async function canMemberUseCommand(
  member,
  commandKey,
) {
  if (!member) return false;

  await loadGuildCommandPermissions(
    member.guild.id,
  );

  return canMemberUseCommandSync(
    member,
    commandKey,
  );
}

async function setMinimumRole(
  guildId,
  commandKey,
  minRoleIndex,
  updatedBy,
) {
  const guildKey =
    String(guildId);

  const normalized =
    minRoleIndex === null
      ? null
      : Number(
          minRoleIndex,
        );

  if (
    normalized !== null &&
    (
      !Number.isInteger(
        normalized,
      ) ||
      normalized < 0 ||
      normalized >=
        STAFF_ROLE_IDS.length
    )
  ) {
    throw new Error(
      'Invalid staff role level.',
    );
  }

  const db =
    await getMongoDb();

  await db
    .collection(
      COLLECTION_NAME,
    )
    .updateOne(
      {
        _id:
          `${guildKey}:${commandKey}`,
      },
      {
        $set: {
          guildId:
            guildKey,
          commandKey,
          minRoleIndex:
            normalized,
          updatedBy:
            String(updatedBy),
          updatedAt:
            new Date(),
        },
      },
      {
        upsert: true,
      },
    );

  const cache =
    ensureGuildCache(
      guildKey,
    );

  cache.set(
    commandKey,
    normalized,
  );

  loadedGuilds.add(
    guildKey,
  );

  return normalized;
}

async function resetMinimumRole(
  guildId,
  commandKey,
) {
  const guildKey =
    String(guildId);

  const db =
    await getMongoDb();

  await db
    .collection(
      COLLECTION_NAME,
    )
    .deleteOne({
      _id:
        `${guildKey}:${commandKey}`,
    });

  const cache =
    ensureGuildCache(
      guildKey,
    );

  cache.delete(
    commandKey,
  );

  loadedGuilds.add(
    guildKey,
  );

  return defaultMinimumRole(
    commandKey,
  );
}

async function authorizeApplicationCommand(
  interaction,
) {
  if (
    !interaction.inGuild?.()
  ) {
    await interaction.reply({
      content:
        'Use this command inside the server.',
      flags:
        MessageFlags.Ephemeral,
    }).catch(() => {});

    return false;
  }

  const member =
    await interaction.guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null);

  if (!member) {
    await interaction.reply({
      content:
        'I could not resolve your staff role.',
      flags:
        MessageFlags.Ephemeral,
    }).catch(() => {});

    return false;
  }

  const commandKey =
    commandKeyFromInteraction(
      interaction,
    );

  await loadGuildCommandPermissions(
    interaction.guild.id,
  );

  if (
    canMemberUseCommandSync(
      member,
      commandKey,
    )
  ) {
    interaction.__snayPermissionAuthorized =
      true;
    interaction.__snayPermissionCommandKey =
      commandKey;
    interaction.__snayStaffLevel =
      getHighestStaffRoleIndex(
        member,
      );

    return true;
  }

  const minimum =
    getMinimumRoleSync(
      interaction.guild.id,
      commandKey,
    );

  const requirement =
    minimum === null
      ? 'Developer only'
      : (
          `<@&${STAFF_ROLE_IDS[minimum]}> ` +
          `or a higher staff role`
        );

  await interaction.reply({
    content:
      `You do not have access to **${commandDisplayName(commandKey)}**.\n` +
      `**Required:** ${requirement}`,
    flags:
      MessageFlags.Ephemeral,
    allowedMentions: {
      parse: [],
    },
  }).catch(() => {});

  return false;
}

async function initializeGuildPermissions(
  guild,
) {
  await loadGuildCommandPermissions(
    guild.id,
    {
      force: true,
    },
  );

  console.log(
    `[STAFF PERMISSIONS] Loaded command permissions for ${guild.name} (${guild.id}).`,
  );
}

function encodeCommandKey(
  commandKey,
) {
  return Buffer.from(
    commandKey,
    'utf8',
  ).toString(
    'base64url',
  );
}

function decodeCommandKey(
  value,
) {
  return Buffer.from(
    String(value),
    'base64url',
  ).toString(
    'utf8',
  );
}

function editableCommands(
  client,
) {
  return [
    ...client.commands.values(),
  ]
    .map((command) =>
      command?.data?.toJSON?.(),
    )
    .filter(Boolean)
    .map((json) => ({
      json,
      commandKey:
        commandKeyFromJson(
          json,
        ),
    }))
    .filter(
      (entry) =>
        entry.commandKey !==
        'chat:permissions',
    )
    .sort((a, b) =>
      commandDisplayName(
        a.commandKey,
      ).localeCompare(
        commandDisplayName(
          b.commandKey,
        ),
      ),
    );
}

async function roleName(
  guild,
  roleId,
) {
  const role =
    guild.roles.cache.get(
      roleId,
    ) ||
    (await guild.roles
      .fetch(roleId)
      .catch(() => null));

  return role?.name ||
    `Missing role ${roleId}`;
}

async function hierarchyText(
  guild,
) {
  const lines = [];

  for (
    let index = 0;
    index <
      STAFF_ROLE_IDS.length;
    index += 1
  ) {
    const id =
      STAFF_ROLE_IDS[index];

    lines.push(
      `**${roleLevelNumber(index)}.** <@&${id}>`,
    );
  }

  return lines.join(
    '\n',
  );
}

async function permissionSummary(
  guild,
  commandKey,
) {
  const minimum =
    getMinimumRoleSync(
      guild.id,
      commandKey,
    );

  if (minimum === null) {
    return (
      '**Developer only** — no staff hierarchy role can use it.'
    );
  }

  const inherited =
    STAFF_ROLE_IDS
      .slice(minimum)
      .map(
        (id) => `<@&${id}>`,
      )
      .join(' → ');

  return (
    `**Minimum role:** <@&${STAFF_ROLE_IDS[minimum]}> ` +
    `(level ${roleLevelNumber(minimum)})\n` +
    `**Inherited upward:** ${inherited}`
  );
}

function permissionPanelCustomId(
  action,
  page,
  commandKey = null,
) {
  const parts = [
    'staffperm',
    action,
    String(
      Math.max(
        0,
        Number(page) || 0,
      ),
    ),
  ];

  if (commandKey) {
    parts.push(
      encodeCommandKey(
        commandKey,
      ),
    );
  }

  return parts.join(':');
}

async function buildPermissionPanel(
  client,
  guild,
  requestedPage = 0,
  selectedCommandKey = null,
  notice = null,
) {
  await loadGuildCommandPermissions(
    guild.id,
  );

  const commands =
    editableCommands(
      client,
    );

  const pageCount =
    Math.max(
      1,
      Math.ceil(
        commands.length /
          COMMANDS_PER_PAGE,
      ),
    );

  const page =
    Math.min(
      Math.max(
        Number(
          requestedPage,
        ) || 0,
        0,
      ),
      pageCount - 1,
    );

  const pageCommands =
    commands.slice(
      page *
        COMMANDS_PER_PAGE,
      page *
        COMMANDS_PER_PAGE +
        COMMANDS_PER_PAGE,
    );

  let selected =
    selectedCommandKey;

  if (
    selected &&
    !commands.some(
      (entry) =>
        entry.commandKey ===
        selected,
    )
  ) {
    selected = null;
  }

  const description = [
    notice || null,
    '**Inheritance rule**',
    'Granting a command to any level automatically grants it to every staff level above it.',
    '',
    '**Hierarchy — lowest → highest**',
    await hierarchyText(
      guild,
    ),
  ]
    .filter(
      (value) =>
        value !== null,
    )
    .join('\n');

  const embed =
    new EmbedBuilder()
      .setColor(
        0x5865f2,
      )
      .setTitle(
        '🔐 Staff Command Permissions',
      )
      .setDescription(
        description,
      )
      .setFooter({
        text:
          `Page ${page + 1}/${pageCount} • Developer-only editor`,
      });

  if (selected) {
    embed.addFields({
      name:
        commandDisplayName(
          selected,
        ),
      value:
        await permissionSummary(
          guild,
          selected,
        ),
      inline:
        false,
    });
  }

  const components = [];

  if (pageCommands.length) {
    const commandMenu =
      new StringSelectMenuBuilder()
        .setCustomId(
          permissionPanelCustomId(
            'command',
            page,
          ),
        )
        .setPlaceholder(
          'Select a command to edit',
        )
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          pageCommands.map(
            ({ json, commandKey }) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(
                  commandDisplayName(
                    commandKey,
                  ).slice(
                    0,
                    100,
                  ),
                )
                .setDescription(
                  String(
                    json.description ||
                    'Application command',
                  ).slice(
                    0,
                    100,
                  ),
                )
                .setValue(
                  encodeCommandKey(
                    commandKey,
                  ),
                )
                .setDefault(
                  commandKey ===
                    selected,
                ),
          ),
        );

    components.push(
      new ActionRowBuilder()
        .addComponents(
          commandMenu,
        ),
    );
  }

  if (selected) {
    const current =
      getMinimumRoleSync(
        guild.id,
        selected,
      );

    const roleMenu =
      new StringSelectMenuBuilder()
        .setCustomId(
          permissionPanelCustomId(
            'role',
            page,
            selected,
          ),
        )
        .setPlaceholder(
          'Set minimum staff role',
        )
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(
              'Developer only',
            )
            .setDescription(
              'No staff hierarchy role can use this command',
            )
            .setValue(
              'developer',
            )
            .setEmoji('🔒')
            .setDefault(
              current === null,
            ),
          ...STAFF_ROLE_IDS.map(
            (roleId, index) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(
                  `Level ${roleLevelNumber(index)} • ${guild.roles.cache.get(roleId)?.name || roleId}`.slice(
                    0,
                    100,
                  ),
                )
                .setDescription(
                  index === 0
                    ? 'Lowest staff level — every staff role inherits access'
                    : `This role and levels ${roleLevelNumber(index + 1)}-${STAFF_ROLE_IDS.length} inherit access`,
                )
                .setValue(
                  String(index),
                )
                .setDefault(
                  current === index,
                ),
          ),
        );

    components.push(
      new ActionRowBuilder()
        .addComponents(
          roleMenu,
        ),
    );

    components.push(
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              permissionPanelCustomId(
                'reset',
                page,
                selected,
              ),
            )
            .setLabel(
              'Reset Default',
            )
            .setEmoji('↩️')
            .setStyle(
              ButtonStyle.Secondary,
            ),
        ),
    );
  }

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              permissionPanelCustomId(
                'page',
                Math.max(
                  0,
                  page - 1,
                ),
              ),
            )
            .setEmoji('⬅️')
            .setStyle(
              ButtonStyle.Secondary,
            )
            .setDisabled(
              page <= 0,
            ),
          new ButtonBuilder()
            .setCustomId(
              permissionPanelCustomId(
                'noop',
                page,
              ),
            )
            .setLabel(
              `Page ${page + 1}/${pageCount}`,
            )
            .setStyle(
              ButtonStyle.Secondary,
            )
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(
              permissionPanelCustomId(
                'page',
                Math.min(
                  pageCount - 1,
                  page + 1,
                ),
              ),
            )
            .setEmoji('➡️')
            .setStyle(
              ButtonStyle.Secondary,
            )
            .setDisabled(
              page >=
                pageCount - 1,
            ),
        ),
    );
  }

  return {
    embeds: [embed],
    components,
    allowedMentions: {
      parse: [],
    },
  };
}

async function sendPermissionPanel(
  interaction,
  client,
) {
  if (
    !interaction.inGuild()
  ) {
    await interaction.reply({
      content:
        'Use this command inside the server.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    !isBotDeveloper(
      interaction.user,
    )
  ) {
    await interaction.reply({
      content:
        'This permissions editor is restricted to the bot developer.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  const payload =
    await buildPermissionPanel(
      client,
      interaction.guild,
      0,
      null,
    );

  await interaction.editReply(
    payload,
  );
}

async function handleStaffPermissionInteraction(
  interaction,
  client,
) {
  const customId =
    interaction.customId;

  if (
    !customId ||
    !customId.startsWith(
      'staffperm:',
    )
  ) {
    return false;
  }

  if (
    !interaction.inGuild()
  ) {
    return true;
  }

  if (
    !isBotDeveloper(
      interaction.user,
    )
  ) {
    await interaction.reply({
      content:
        'This permissions editor is restricted to the bot developer.',
      flags:
        MessageFlags.Ephemeral,
    }).catch(() => {});

    return true;
  }

  const parts =
    customId.split(':');

  const action =
    parts[1];

  const page =
    Number(
      parts[2],
    ) || 0;

  if (
    action === 'noop'
  ) {
    await interaction
      .deferUpdate()
      .catch(() => {});

    return true;
  }

  if (
    action === 'page' &&
    interaction.isButton()
  ) {
    await interaction.deferUpdate();

    const payload =
      await buildPermissionPanel(
        client,
        interaction.guild,
        page,
        null,
      );

    await interaction.editReply(
      payload,
    );

    return true;
  }

  if (
    action === 'command' &&
    interaction.isStringSelectMenu()
  ) {
    const commandKey =
      decodeCommandKey(
        interaction.values[0],
      );

    await interaction.deferUpdate();

    const payload =
      await buildPermissionPanel(
        client,
        interaction.guild,
        page,
        commandKey,
      );

    await interaction.editReply(
      payload,
    );

    return true;
  }

  if (
    action === 'role' &&
    interaction.isStringSelectMenu()
  ) {
    const commandKey =
      decodeCommandKey(
        parts[3],
      );

    const value =
      interaction.values[0];

    const minimum =
      value === 'developer'
        ? null
        : Number(value);

    await interaction.deferUpdate();

    await setMinimumRole(
      interaction.guild.id,
      commandKey,
      minimum,
      interaction.user.id,
    );

    const notice =
      minimum === null
        ? `✅ **${commandDisplayName(commandKey)}** is now developer only.`
        : (
            `✅ **${commandDisplayName(commandKey)}** now requires ` +
            `<@&${STAFF_ROLE_IDS[minimum]}> or higher.`
          );

    const payload =
      await buildPermissionPanel(
        client,
        interaction.guild,
        page,
        commandKey,
        notice,
      );

    await interaction.editReply(
      payload,
    );

    return true;
  }

  if (
    action === 'reset' &&
    interaction.isButton()
  ) {
    const commandKey =
      decodeCommandKey(
        parts[3],
      );

    await interaction.deferUpdate();

    await resetMinimumRole(
      interaction.guild.id,
      commandKey,
    );

    const payload =
      await buildPermissionPanel(
        client,
        interaction.guild,
        page,
        commandKey,
        `↩️ Reset **${commandDisplayName(commandKey)}** to its default access level.`,
      );

    await interaction.editReply(
      payload,
    );

    return true;
  }

  return true;
}

module.exports = {
  DEFAULT_MINIMUM_ROLE,
  commandKeyFromJson,
  commandKeyFromInteraction,
  commandDisplayName,
  loadGuildCommandPermissions,
  initializeGuildPermissions,
  getMinimumRole,
  getMinimumRoleSync,
  setMinimumRole,
  resetMinimumRole,
  canMemberUseCommand,
  canMemberUseCommandSync,
  authorizeApplicationCommand,
  sendPermissionPanel,
  handleStaffPermissionInteraction,
};
