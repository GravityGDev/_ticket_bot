const {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const HELP_MENU_COMMANDS_PER_PAGE = 23;
const HELP_COLLECTOR_TIME = 15 * 60 * 1000;

const OPTION_TYPE_NAMES = {
  [ApplicationCommandOptionType.Subcommand]: 'Subcommand',
  [ApplicationCommandOptionType.SubcommandGroup]: 'Subcommand Group',
  [ApplicationCommandOptionType.String]: 'Text',
  [ApplicationCommandOptionType.Integer]: 'Integer',
  [ApplicationCommandOptionType.Boolean]: 'True / False',
  [ApplicationCommandOptionType.User]: 'User',
  [ApplicationCommandOptionType.Channel]: 'Channel',
  [ApplicationCommandOptionType.Role]: 'Role',
  [ApplicationCommandOptionType.Mentionable]: 'User / Role',
  [ApplicationCommandOptionType.Number]: 'Number',
  [ApplicationCommandOptionType.Attachment]: 'Attachment',
};

function humanizePermissionName(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim();
}

function commandJson(command) {
  try {
    return command?.data?.toJSON?.() || null;
  } catch {
    return null;
  }
}

function commandRequiredPermissions(json) {
  const raw =
    json?.default_member_permissions;

  if (
    raw === null ||
    raw === undefined
  ) {
    return null;
  }

  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function memberCanUseCommand(member, json) {
  const required =
    commandRequiredPermissions(
      json,
    );

  // No default permission restriction.
  if (
    required === null
  ) {
    return true;
  }

  // Discord's Administrator permission bypasses other channel/server perms.
  if (
    member.permissions.has(
      PermissionFlagsBits.Administrator,
    )
  ) {
    return true;
  }

  // "0" means there are no normal default member permissions.
  if (required === 0n) {
    return false;
  }

  return member.permissions.has(
    required,
  );
}

function permissionLabel(json) {
  const required =
    commandRequiredPermissions(
      json,
    );

  if (required === null) {
    return 'No special Discord permission';
  }

  if (required === 0n) {
    return 'Restricted by Discord command permissions';
  }

  const matches = [];

  for (
    const [name, bit] of
    Object.entries(PermissionFlagsBits)
  ) {
    if (
      typeof bit !== 'bigint'
    ) {
      continue;
    }

    if (
      (required & bit) === bit
    ) {
      matches.push(
        humanizePermissionName(
          name,
        ),
      );
    }
  }

  return (
    matches.join(', ') ||
    'Restricted'
  );
}

function getAvailableCommands(
  client,
  member,
) {
  return [
    ...client.commands.values(),
  ]
    .map((command) => ({
      command,
      json:
        commandJson(command),
    }))
    .filter(
      ({ json }) =>
        json?.name &&
        (
          json.type === undefined ||
          json.type ===
            ApplicationCommandType.ChatInput
        ) &&
        memberCanUseCommand(
          member,
          json,
        ),
    )
    .sort((left, right) =>
      left.json.name.localeCompare(
        right.json.name,
      ),
    );
}

async function getRegisteredCommandIds(
  interaction,
  client,
) {
  const ids = new Map();

  // Guild commands are used when GUILD_ID is configured.
  if (interaction.guild) {
    const guildCommands =
      await interaction.guild.commands
        .fetch()
        .catch(() => null);

    if (guildCommands) {
      for (
        const command of
        guildCommands.values()
      ) {
        ids.set(
          command.name,
          command.id,
        );
      }
    }
  }

  // Global commands are used when GUILD_ID is not configured.
  const globalCommands =
    await client.application?.commands
      ?.fetch()
      .catch(() => null);

  if (globalCommands) {
    for (
      const command of
      globalCommands.values()
    ) {
      if (
        !ids.has(
          command.name,
        )
      ) {
        ids.set(
          command.name,
          command.id,
        );
      }
    }
  }

  return ids;
}

function commandMention(
  name,
  commandIds,
  path = null,
) {
  const id =
    commandIds.get(name);

  const displayPath =
    path
      ? `${name} ${path}`
      : name;

  if (!id) {
    return `\`/${displayPath}\``;
  }

  return `</${displayPath}:${id}>`;
}

function trimText(
  value,
  maxLength,
) {
  const text =
    String(value || '');

  if (
    text.length <= maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(
        0,
        maxLength - 1,
      ),
    ) + '…'
  );
}

function optionSyntax(option) {
  const name =
    option.name;

  return option.required
    ? `<${name}>`
    : `[${name}]`;
}

function buildSimpleSyntax(
  commandName,
  options,
) {
  const args =
    (options || [])
      .filter(
        (option) =>
          option.type !==
            ApplicationCommandOptionType.Subcommand &&
          option.type !==
            ApplicationCommandOptionType.SubcommandGroup,
      )
      .map(
        optionSyntax,
      )
      .join(' ');

  return (
    `/${commandName}` +
    (args ? ` ${args}` : '')
  );
}

function getSubcommandEntries(
  commandName,
  options,
  groupName = null,
) {
  const entries = [];

  for (
    const option of options || []
  ) {
    if (
      option.type ===
      ApplicationCommandOptionType.Subcommand
    ) {
      const path =
        [
          groupName,
          option.name,
        ]
          .filter(Boolean)
          .join(' ');

      const args =
        (option.options || [])
          .map(
            optionSyntax,
          )
          .join(' ');

      entries.push({
        path,
        description:
          option.description ||
          'No description provided.',
        options:
          option.options || [],
        syntax:
          `/${commandName} ${path}` +
          (args
            ? ` ${args}`
            : ''),
      });

      continue;
    }

    if (
      option.type ===
      ApplicationCommandOptionType.SubcommandGroup
    ) {
      entries.push(
        ...getSubcommandEntries(
          commandName,
          option.options || [],
          option.name,
        ),
      );
    }
  }

  return entries;
}

function formatArgumentLines(
  options,
) {
  const lines = [];

  for (
    const option of options || []
  ) {
    if (
      option.type ===
        ApplicationCommandOptionType.Subcommand ||
      option.type ===
        ApplicationCommandOptionType.SubcommandGroup
    ) {
      continue;
    }

    const type =
      OPTION_TYPE_NAMES[
        option.type
      ] || 'Value';

    const requirement =
      option.required
        ? '**Required**'
        : 'Optional';

    let extra = '';

    if (
      Array.isArray(
        option.choices,
      ) &&
      option.choices.length
    ) {
      extra =
        ` • Choices: ${option.choices
          .slice(0, 8)
          .map(
            (choice) =>
              `\`${choice.name}\``,
          )
          .join(', ')}`;

      if (
        option.choices.length > 8
      ) {
        extra +=
          ` +${option.choices.length - 8} more`;
      }
    }

    lines.push(
      `• \`${option.name}\` — ${type} — ${requirement}\n` +
        `  ${option.description || 'No description provided.'}${extra}`,
    );
  }

  return lines;
}

function menuPageCount(
  commandCount,
) {
  return Math.max(
    1,
    Math.ceil(
      commandCount /
        HELP_MENU_COMMANDS_PER_PAGE,
    ),
  );
}

function commandsOnPage(
  commands,
  page,
) {
  const pageCount =
    menuPageCount(
      commands.length,
    );

  const safePage =
    Math.min(
      Math.max(
        Number(page) || 0,
        0,
      ),
      pageCount - 1,
    );

  const start =
    safePage *
    HELP_MENU_COMMANDS_PER_PAGE;

  return {
    page:
      safePage,
    pageCount,
    commands:
      commands.slice(
        start,
        start +
          HELP_MENU_COMMANDS_PER_PAGE,
      ),
  };
}

function buildHelpSelect(
  availableCommands,
  page,
  selectedCommandName = null,
) {
  const pageData =
    commandsOnPage(
      availableCommands,
      page,
    );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        `help:commands:${pageData.page}`,
      )
      .setPlaceholder(
        'Select a command for more information',
      )
      .setMinValues(1)
      .setMaxValues(1);

  const options = [];

  if (
    pageData.page > 0
  ) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(
          'Previous Page',
        )
        .setDescription(
          `Go to page ${pageData.page}`,
        )
        .setValue(
          '__help_previous__',
        )
        .setEmoji('⬅️'),
    );
  }

  for (
    const { json } of
    pageData.commands
  ) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(
          `/${json.name}`.slice(
            0,
            100,
          ),
        )
        .setDescription(
          trimText(
            json.description ||
              'No description provided.',
            100,
          ),
        )
        .setValue(
          `command:${json.name}`,
        )
        .setDefault(
          json.name ===
            selectedCommandName,
        ),
    );
  }

  if (
    pageData.page <
    pageData.pageCount - 1
  ) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(
          'Next Page',
        )
        .setDescription(
          `Go to page ${pageData.page + 2}`,
        )
        .setValue(
          '__help_next__',
        )
        .setEmoji('➡️'),
    );
  }

  menu.addOptions(
    options,
  );

  return {
    row:
      new ActionRowBuilder()
        .addComponents(menu),
    ...pageData,
  };
}

function buildCommandListEmbed(
  availableCommands,
  commandIds,
  page,
) {
  const pageData =
    commandsOnPage(
      availableCommands,
      page,
    );

  const lines =
    pageData.commands.map(
      ({ json }) =>
        `${commandMention(json.name, commandIds)} — ` +
        `${json.description || 'No description provided.'}`,
    );

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      '📚 Staff Command Help',
    )
    .setDescription(
      `Showing **${availableCommands.length}** command${
        availableCommands.length === 1
          ? ''
          : 's'
      } available to you.\n` +
        'Commands you do not have permission to use are automatically hidden.\n\n' +
        (lines.length
          ? lines.join('\n')
          : 'No commands are available to you.'),
    )
    .setFooter({
      text:
        `Page ${pageData.page + 1}/${pageData.pageCount} • ` +
        'Slash-command mentions above are clickable.',
    });
}

function buildCommandDetailEmbed(
  json,
  commandIds,
) {
  const rootMention =
    commandMention(
      json.name,
      commandIds,
    );

  const subcommands =
    getSubcommandEntries(
      json.name,
      json.options || [],
    );

  const sections = [];

  sections.push(
    `${json.description || 'No description provided.'}`,
  );

  sections.push(
    `**Permission**\n${permissionLabel(json)}`,
  );

  if (subcommands.length) {
    const commandLines = [];

    for (
      const subcommand of
      subcommands
    ) {
      commandLines.push(
        `**${commandMention(
          json.name,
          commandIds,
          subcommand.path,
        )}**\n` +
          `\`${subcommand.syntax}\`\n` +
          `${subcommand.description}`,
      );

      const argumentsList =
        formatArgumentLines(
          subcommand.options,
        );

      if (
        argumentsList.length
      ) {
        commandLines.push(
          argumentsList.join(
            '\n',
          ),
        );
      }
    }

    sections.push(
      `**Subcommands & Arguments**\n${commandLines.join('\n\n')}`,
    );
  } else {
    const syntax =
      buildSimpleSyntax(
        json.name,
        json.options || [],
      );

    sections.push(
      `**Usage**\n\`${syntax}\``,
    );

    const argumentsList =
      formatArgumentLines(
        json.options || [],
      );

    sections.push(
      argumentsList.length
        ? `**Arguments**\n${argumentsList.join('\n')}`
        : '**Arguments**\nNo arguments.',
    );
  }

  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle(
      `ℹ️ /${json.name}`,
    )
    .setDescription(
      trimText(
        sections.join(
          '\n\n',
        ),
        4000,
      ),
    )
    .setFooter({
      text:
        `${rootMention.replace(/<|>/g, '')} • ` +
        '<argument> = required • [argument] = optional',
    });
}

function buildHelpPayload({
  availableCommands,
  commandIds,
  page,
  selectedCommandName = null,
}) {
  const menu =
    buildHelpSelect(
      availableCommands,
      page,
      selectedCommandName,
    );

  const embeds = [
    buildCommandListEmbed(
      availableCommands,
      commandIds,
      menu.page,
    ),
  ];

  if (
    selectedCommandName
  ) {
    const selected =
      availableCommands.find(
        ({ json }) =>
          json.name ===
          selectedCommandName,
      );

    if (selected) {
      embeds.push(
        buildCommandDetailEmbed(
          selected.json,
          commandIds,
        ),
      );
    }
  }

  return {
    page:
      menu.page,
    embeds,
    components:
      availableCommands.length
        ? [menu.row]
        : [],
    allowedMentions: {
      parse: [],
    },
  };
}

module.exports = {
  data:
    new SlashCommandBuilder()
      .setName('help')
      .setDescription(
        'Show the staff commands available to you.',
      )
      .setDefaultMemberPermissions(
        PermissionFlagsBits.ViewAuditLog,
      ),

  async execute(
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

    const member =
      await interaction.guild.members
        .fetch(
          interaction.user.id,
        )
        .catch(
          () => null,
        );

    if (
      !member ||
      !member.permissions.has(
        PermissionFlagsBits.ViewAuditLog,
      )
    ) {
      await interaction.reply({
        content:
          'You need **View Audit Log** staff permission to use `/help`.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }

    const availableCommands =
      getAvailableCommands(
        client,
        member,
      );

    const commandIds =
      await getRegisteredCommandIds(
        interaction,
        client,
      );

    let currentPage = 0;
    let selectedCommandName = null;

    const initialPayload =
      buildHelpPayload({
        availableCommands,
        commandIds,
        page:
          currentPage,
        selectedCommandName,
      });

    await interaction.reply({
      ...initialPayload,
      flags:
        MessageFlags.Ephemeral,
    });

    const message =
      await interaction
        .fetchReply()
        .catch(
          () => null,
        );

    if (
      !message ||
      !availableCommands.length
    ) {
      return;
    }

    const collector =
      message.createMessageComponentCollector({
        time:
          HELP_COLLECTOR_TIME,
        filter:
          (componentInteraction) =>
            componentInteraction.user.id ===
            interaction.user.id,
      });

    collector.on(
      'collect',
      async (
        componentInteraction,
      ) => {
        if (
          !componentInteraction.isStringSelectMenu() ||
          !componentInteraction.customId.startsWith(
            'help:commands:',
          )
        ) {
          return;
        }

        const value =
          componentInteraction.values[0];

        if (
          value ===
          '__help_next__'
        ) {
          currentPage += 1;
          selectedCommandName =
            null;
        } else if (
          value ===
          '__help_previous__'
        ) {
          currentPage -= 1;
          selectedCommandName =
            null;
        } else if (
          value.startsWith(
            'command:',
          )
        ) {
          selectedCommandName =
            value.slice(
              'command:'.length,
            );
        }

        const payload =
          buildHelpPayload({
            availableCommands,
            commandIds,
            page:
              currentPage,
            selectedCommandName,
          });

        currentPage =
          payload.page;

        await componentInteraction.update(
          payload,
        );
      },
    );

    collector.on(
      'end',
      async () => {
        const payload =
          buildHelpPayload({
            availableCommands,
            commandIds,
            page:
              currentPage,
            selectedCommandName,
          });

        for (
          const row of
          payload.components
        ) {
          for (
            const component of
            row.components
          ) {
            component.setDisabled(
              true,
            );
          }
        }

        await interaction
          .editReply(payload)
          .catch(
            () => {},
          );
      },
    );
  },
};
