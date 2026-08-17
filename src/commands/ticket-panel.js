const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { buildPanelMessage } = require('../ticket-system');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Send the ticket creation panel in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    if (!interaction.channel?.isTextBased()) {
      await interaction.reply({
        content: 'Use this command in a text channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply(buildPanelMessage());
  },
};
