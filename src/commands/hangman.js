const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { isBotDeveloper } = require('../staff-role-hierarchy');
const { openHangmanSetup } = require('../hangman-game');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hangman')
    .setDescription('Start a Hangman game inside an open Dev test ticket.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!isBotDeveloper(interaction.user)) {
      await interaction.reply({
        content: 'Only the bot developer can use `/hangman`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await openHangmanSetup(interaction);
  },
};
