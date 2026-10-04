const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { sendRankBetaCard } = require('../staff-rank-beta');
const { isBotDeveloper } = require('../staff-role-hierarchy');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank-beta')
    .setDescription('Preview the new Snay.io staff rank card.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('staff')
        .setDescription('Optional staff member to view. Defaults to yourself.')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('Stats period. Defaults to lifetime.')
        .setRequired(false)
        .addChoices(
          { name: 'Lifetime', value: 'lifetime' },
          { name: 'Weekly • last 7 days', value: 'weekly' },
          { name: 'Monthly • last 30 days', value: 'monthly' },
          { name: 'Quarterly • last 90 days', value: 'quarterly' },
        ),
    ),

  async execute(interaction) {
    if (!isBotDeveloper(interaction.user)) {
      await interaction.reply({
        content: 'Only the bot developer can use `/rank-beta`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await sendRankBetaCard(
      interaction,
      interaction.options.getString('period') || 'lifetime',
    );
  },
};
