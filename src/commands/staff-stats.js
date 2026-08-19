const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { sendStaffTrackingPanel } = require('../staff-tracking');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff-stats')
    .setDescription('Open the staff performance and activity dashboard.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content: 'You need **Administrator** permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await sendStaffTrackingPanel(interaction);
  },
};
