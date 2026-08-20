const {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { updateBotStatus } = require('../bot-status');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('Update the bot status/activity shown on its Discord profile.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The status/activity text to display.')
        .setRequired(true)
        .setMaxLength(128),
    )
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('How Discord should display the activity.')
        .setRequired(false)
        .addChoices(
          { name: 'Watching', value: 'watching' },
          { name: 'Playing', value: 'playing' },
          { name: 'Listening', value: 'listening' },
          { name: 'Competing', value: 'competing' },
          { name: 'Custom status', value: 'custom' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('presence')
        .setDescription('The bot online indicator.')
        .setRequired(false)
        .addChoices(
          { name: 'Online', value: 'online' },
          { name: 'Idle', value: 'idle' },
          { name: 'Do Not Disturb', value: 'dnd' },
          { name: 'Invisible', value: 'invisible' },
        ),
    ),

  async execute(interaction, client) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      !interaction.__snayPermissionAuthorized &&
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content: 'You need **Administrator** permission to update the bot status.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const message = interaction.options.getString('message', true);
    const type =
      interaction.options.getString('type') || 'watching';
    const status =
      interaction.options.getString('presence') || 'online';

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const updated = await updateBotStatus(
        client,
        {
          message,
          type,
          status,
        },
        interaction.user.id,
      );

      const labels = {
        watching: 'Watching',
        playing: 'Playing',
        listening: 'Listening to',
        competing: 'Competing in',
        custom: 'Custom',
      };

      const preview =
        updated.type === 'custom'
          ? updated.message
          : `${labels[updated.type]} ${updated.message}`;

      await interaction.editReply(
        `✅ Bot status updated and saved to MongoDB.\n**Preview:** ${preview}\n**Presence:** ${updated.status}`,
      );
    } catch (error) {
      console.error('[BOT STATUS COMMAND ERROR]', error);

      await interaction.editReply(
        `I could not update the bot status: ${error?.message || 'Unknown error'}`,
      );
    }
  },
};
