const {
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { sendRankCard } = require('../staff-rank');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('View your staff activity rank card.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog)
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
    await sendRankCard(
      interaction,
      interaction.options.getString('period') || 'lifetime',
    );
  },
};
