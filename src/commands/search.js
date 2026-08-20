const {
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  executeSkinSearch,
} = require('../skin-review');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search the skin review channel by skin / clan ID.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ViewAuditLog,
    )
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('24-character skin / clan / badge ID.')
        .setRequired(true)
        .setMinLength(24)
        .setMaxLength(24),
    ),

  async execute(interaction, client) {
    await executeSkinSearch(interaction, client);
  },
};
