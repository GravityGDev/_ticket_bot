const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  createWarningRemovalSchedule,
} = require('../staff-settings-store');
const {
  parseLondonLocalDateTime,
} = require('../staff-settings');

const WARNING_ROLES = Object.freeze({
  warning1: '961199921841713162',
  warning2: '961199596212744252',
});

const REMOVE_DURATIONS = Object.freeze({
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

function getRemovalDate(duration, customDate) {
  if (duration === 'custom') {
    if (!customDate) {
      throw new Error(
        'You selected **Custom date/time**, so you must fill in `custom-date`.',
      );
    }

    return parseLondonLocalDateTime(customDate);
  }

  const milliseconds = REMOVE_DURATIONS[duration];

  if (!milliseconds) {
    throw new Error('Invalid warning removal duration.');
  }

  return new Date(Date.now() + milliseconds);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a staff member and schedule automatic role removal.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('staff')
        .setDescription('Staff member to warn.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the warning.')
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addStringOption((option) =>
      option
        .setName('warning-role')
        .setDescription('Which warning role to give.')
        .setRequired(true)
        .addChoices(
          {
            name: 'Warning 1',
            value: WARNING_ROLES.warning1,
          },
          {
            name: 'Warning 2',
            value: WARNING_ROLES.warning2,
          },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('remove-in')
        .setDescription('When the warning should automatically be removed.')
        .setRequired(true)
        .addChoices(
          { name: '30 minutes', value: '30m' },
          { name: '1 hour', value: '1h' },
          { name: '6 hours', value: '6h' },
          { name: '12 hours', value: '12h' },
          { name: '1 day', value: '1d' },
          { name: '3 days', value: '3d' },
          { name: '7 days', value: '7d' },
          { name: '14 days', value: '14d' },
          { name: '30 days', value: '30d' },
          { name: 'Custom date/time', value: 'custom' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('custom-date')
        .setDescription('Only for Custom: UK time, e.g. 2026-09-01 18:30.')
        .setRequired(false)
        .setMaxLength(80),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content: 'You need **Administrator** permission to use `/warn`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const targetUser = interaction.options.getUser('staff', true);
      const reason = interaction.options.getString('reason', true).trim();
      const roleId = interaction.options.getString('warning-role', true);
      const duration = interaction.options.getString('remove-in', true);
      const customDate = interaction.options.getString('custom-date');

      const member = await interaction.guild.members
        .fetch(targetUser.id)
        .catch(() => null);

      if (!member || member.user.bot) {
        throw new Error('The selected staff member is not available.');
      }

      if (
        !member.permissions.has(PermissionFlagsBits.ViewAuditLog)
      ) {
        throw new Error('This user is not Snay.io staff.');
      }

      const role =
        interaction.guild.roles.cache.get(roleId) ||
        (await interaction.guild.roles.fetch(roleId).catch(() => null));

      if (!role) {
        throw new Error('That configured warning role no longer exists.');
      }

      const botMember =
        interaction.guild.members.me ||
        (await interaction.guild.members.fetchMe());

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('The bot needs **Manage Roles**.');
      }

      if (
        role.managed ||
        role.position >= botMember.roles.highest.position
      ) {
        throw new Error(
          'The bot cannot manage that warning role. Move the bot role above it.',
        );
      }

      const executeAt = getRemovalDate(duration, customDate);

      if (executeAt.getTime() <= Date.now()) {
        throw new Error('The warning removal date must be in the future.');
      }

      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(
          role,
          `Staff warning by ${interaction.user.tag}: ${reason}`,
        );
      }

      const schedule = await createWarningRemovalSchedule(
        interaction.guild.id,
        {
          userId: member.id,
          roleId: role.id,
          executeAt,
          reason,
        },
        interaction.user.id,
      );

      const unix = Math.floor(
        new Date(schedule.executeAt).getTime() / 1000,
      );

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚠️ Staff Warning')
        .setDescription(`<@${member.id}> has received a staff warning.`)
        .addFields(
          {
            name: 'Warning Role',
            value: `<@&${role.id}>`,
            inline: true,
          },
          {
            name: 'Issued By',
            value: `<@${interaction.user.id}>`,
            inline: true,
          },
          {
            name: 'Reason',
            value: reason,
          },
          {
            name: 'Automatic Removal',
            // Discord's relative timestamp updates live in the client.
            value: `<t:${unix}:F>\n**Removes <t:${unix}:R>**`,
          },
        )
        .setFooter({
          text: 'The removal countdown updates automatically.',
        })
        .setTimestamp();

      // Send as a completely new channel message rather than using the slash
      // command response as the visible warning.
      await interaction.channel.send({
        content: `<@${member.id}>`,
        embeds: [embed],
        allowedMentions: {
          users: [member.id, interaction.user.id],
          roles: [],
        },
      });

      // Remove the temporary slash-command acknowledgement so only the clean
      // new warning message remains.
      await interaction.deleteReply().catch(() => {});
    } catch (error) {
      console.error('[WARN COMMAND ERROR]', error);

      await interaction.editReply(
        `I could not create that warning: ${error?.message || 'Unknown error'}`,
      );
    }
  },
};
