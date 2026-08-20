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
    .setDescription('Search media by ID or open the skin/clan blacklist manager.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('Optional 24-character skin / clan / badge ID for a quick search.')
        .setRequired(false)
        .setMinLength(24)
        .setMaxLength(24),
    ),

  async execute(interaction, client) {
    await executeSkinSearch(interaction, client);
  },
};
