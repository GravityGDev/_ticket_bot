const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { sendTicketPanelCommand } = require('../ticket-system');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Send or configure the ticket creation panel in this channel.')
    .addBooleanOption((option) =>
      option
        .setName('reconfigure')
        .setDescription('Run the ticket setup again for this server.'),
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    ),

  async execute(interaction) {
    if (!interaction.guild || !interaction.channel?.isTextBased()) {
      await interaction.reply({
        content: 'Use this command in a text channel inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content:
          'You need **Administrator** permission to use `/ticket-panel`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await sendTicketPanelCommand(
      interaction,
      interaction.options.getBoolean('reconfigure') === true,
    );
  },
};
