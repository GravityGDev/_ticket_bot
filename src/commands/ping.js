const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the bot is online.'),

  async execute(interaction) {
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
