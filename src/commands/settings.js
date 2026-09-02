const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  isBotDeveloper,
} = require('../staff-role-hierarchy');
const {
  getAssistBypassRoleId,
  setAssistBypassRole,
  removeAssistBypassRole,
} = require('../assist-settings-store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure bot settings for this server.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('assist')
        .setDescription('Add or remove the role that bypasses Assist ownership checks.')
        .addRoleOption((option) =>
          option
            .setName('role')
            .setDescription('The role to add or remove as the Assist bypass role.')
            .setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('True adds the role; false removes it.')
            .setRequired(true),
        ),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isBotDeveloper(interaction.user)) {
      await interaction.reply({
        content: 'Only the bot developer can change Assist settings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand !== 'assist') return;

    const role = interaction.options.getRole('role', true);
    const enabled = interaction.options.getBoolean('enabled', true);

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    if (enabled) {
      await setAssistBypassRole(
        interaction.guild.id,
        role.id,
        interaction.user.id,
      );

      await interaction.editReply(
        `✅ <@&${role.id}> can now bypass ticket Assist ownership checks and use every Assist function.`,
      );
      return;
    }

    const configuredRoleId =
      await getAssistBypassRoleId(
        interaction.guild.id,
      );

    if (configuredRoleId !== role.id) {
      await interaction.editReply(
        configuredRoleId
          ? `❌ <@&${role.id}> is not the configured Assist bypass role. The current role is <@&${configuredRoleId}>.`
          : '❌ No Assist bypass role is currently configured.',
      );
      return;
    }

    await removeAssistBypassRole(
      interaction.guild.id,
      role.id,
    );

    await interaction.editReply(
      `✅ <@&${role.id}> can no longer bypass ticket Assist ownership checks.`,
    );
  },
};
