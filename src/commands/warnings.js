const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  buildWarningHistoryPayload,
} = require('../warn-system');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View a staff member’s full warning history.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ViewAuditLog,
    )
    .addUserOption((option) =>
      option
        .setName('staff')
        .setDescription('Staff member whose warning history you want to view.')
        .setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requester = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);

    if (
      !requester ||
      !requester.permissions.has(
        PermissionFlagsBits.ViewAuditLog,
      )
    ) {
      await interaction.reply({
        content:
          'You need **View Audit Log** staff permission to view warning history.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options.getUser(
      'staff',
      true,
    );

    const targetMember = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    if (
      !targetMember ||
      targetMember.user.bot ||
      !targetMember.permissions.has(
        PermissionFlagsBits.ViewAuditLog,
      )
    ) {
      await interaction.reply({
        content: "This user isn't Snay.io staff.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });

      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 3000);

      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const payload = await buildWarningHistoryPayload(
        interaction.guild,
        targetMember,
        interaction.user.id,
        0,
      );

      await interaction.editReply(payload);
    } catch (error) {
      console.error('[WARNINGS COMMAND ERROR]', error);

      await interaction.editReply({
        content:
          'I could not load that staff member’s warning history.',
        embeds: [],
        components: [],
      });
    }
  },
};
