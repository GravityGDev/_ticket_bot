const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { parseTicketMuteExpiry, setTicketMute } = require('../ticket-access');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket-mute')
    .setDescription('Prevent a user from creating tickets. Access is configured in /permissions.')
    .addUserOption(option => option.setName('user').setDescription('User to ticket-mute').setRequired(true))
    .addStringOption(option => option.setName('duration').setDescription('permanent, 20d, 24h, 1w, 6d, 1m (minute), 1mon (month)').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('Reason for the ticket mute').setMaxLength(500)),
  async execute(interaction) {
    if (!interaction.guild || !interaction.__snayPermissionAuthorized) return;
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    let expiresAt;
    try {
      expiresAt = parseTicketMuteExpiry(interaction.options.getString('duration', true));
    } catch (error) {
      await interaction.editReply({ content: error.message });
      return;
    }
    const user = interaction.options.getUser('user', true);
    try {
      await setTicketMute(interaction.guild.id, user.id, expiresAt, interaction.user.id, interaction.options.getString('reason'));
    } catch (error) {
      console.error('[TICKET MUTE SAVE ERROR]', error);
      await interaction.editReply({ content: 'I could not save the ticket mute. Please try again. If this continues, ask the bot developer to check the MongoDB connection and write permissions.' });
      return;
    }
    await interaction.editReply({ content: expiresAt ? `Ticket creation muted for <@${user.id}> until <t:${Math.floor(expiresAt.getTime() / 1000)}:F>.` : `Ticket creation permanently muted for <@${user.id}>.`, allowedMentions: { parse: [] } });
  },
};
