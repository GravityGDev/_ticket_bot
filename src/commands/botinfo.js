const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('Show basic information about the bot.')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    ),

  async execute(interaction) {
    if (
      !interaction.inGuild() ||
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content:
          'You need **Administrator** permission to use `/botinfo`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const client = interaction.client;

    const embed = new EmbedBuilder()
      .setTitle(client.user.username)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Servers', value: String(client.guilds.cache.size), inline: true },
        { name: 'Ping', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: 'Node.js', value: process.version, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
