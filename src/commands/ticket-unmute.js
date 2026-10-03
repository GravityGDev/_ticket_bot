const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { removeTicketMute } = require('../ticket-access');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-unmute')
    .setDescription('Remove a ticket-creation mute. Access is configured in /permissions.')
    .addUserOption(option => option.setName('user').setDescription('User to ticket-unmute').setRequired(true)),
  async execute(interaction) {
    if (!interaction.guild || !interaction.__snayPermissionAuthorized) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user', true);
    const result = await removeTicketMute(interaction.guild.id, user.id);
    await interaction.editReply({ content: result.deletedCount ? `Removed the ticket-creation mute for <@${user.id}>.` : `<@${user.id}> has no ticket-creation mute.`, allowedMentions: { parse: [] } });
  },
};
