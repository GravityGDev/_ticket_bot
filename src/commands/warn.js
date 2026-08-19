const {
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

const WARNING_ROLE_IDS = Object.freeze([
  '961199921841713162',
  '961199596212744252',
]);

function chooseAutomaticWarningRole(member) {
  for (const roleId of WARNING_ROLE_IDS) {
    if (!member.roles.cache.has(roleId)) return roleId;
  }

  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a staff member and schedule the warning role removal.')
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
        .setName('remove-date')
        .setDescription('UK time, e.g. 2026-09-01 18:30.')
        .setRequired(true)
        .setMaxLength(80),
    )
    .addRoleOption((option) =>
      option
        .setName('warning-role')
        .setDescription('Optional. Defaults to the next available warning role.')
        .setRequired(false),
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
      const removeDateInput = interaction.options.getString(
        'remove-date',
        true,
      );
      const selectedRole = interaction.options.getRole('warning-role');

      const member = await interaction.guild.members
        .fetch(targetUser.id)
        .catch(() => null);

      if (!member || member.user.bot) {
        throw new Error('The selected staff member is not available.');
      }

      if (
        !member.permissions.has(PermissionFlagsBits.ViewAuditLog)
      ) {
        throw new Error(
          'The selected member does not currently have View Audit Log staff permission.',
        );
      }

      let roleId;

      if (selectedRole) {
        if (!WARNING_ROLE_IDS.includes(selectedRole.id)) {
          throw new Error(
            'Choose one of the configured warning roles for this command.',
          );
        }
        roleId = selectedRole.id;
      } else {
        roleId = chooseAutomaticWarningRole(member);

        if (!roleId) {
          throw new Error(
            'This staff member already has both configured warning roles. Select a warning role explicitly if you want to replace its removal schedule.',
          );
        }
      }

      const role =
        interaction.guild.roles.cache.get(roleId) ||
        (await interaction.guild.roles.fetch(roleId).catch(() => null));

      if (!role) throw new Error('The warning role no longer exists.');

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

      const executeAt = parseLondonLocalDateTime(removeDateInput);

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

      const unix = Math.floor(new Date(schedule.executeAt).getTime() / 1000);

      await interaction.editReply(
        `✅ Warned <@${member.id}> with <@&${role.id}>.\n` +
          `**Reason:** ${reason}\n` +
          `**Automatic removal:** <t:${unix}:F> (<t:${unix}:R>)`,
      );
    } catch (error) {
      console.error('[WARN COMMAND ERROR]', error);
      await interaction.editReply(
        `I could not create that warning: ${error?.message || 'Unknown error'}`,
      );
    }
  },
};
