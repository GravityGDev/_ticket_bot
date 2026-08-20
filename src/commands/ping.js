const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is online.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ViewAuditLog,
    ),

  async execute(interaction) {
    if (
      !interaction.__snayPermissionAuthorized &&
      (
        !interaction.inGuild() ||
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.ViewAuditLog,
        )
      )
    ) {
      await interaction.reply({
        content:
          'You need **View Audit Log** staff permission to use `/ping`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sent = await interaction.reply({
      content: 'Pinging...',
      fetchReply: true,
    });

    const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
    const websocket = Math.round(interaction.client.ws.ping);

    await interaction.editReply(
      `🏓 Pong! Round trip: ${roundTrip}ms | WebSocket: ${websocket}ms`,
    );
  },
};
