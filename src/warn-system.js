const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const {
  getWarningRemovalSchedule,
  revokeWarningRemovalSchedule,
  updateWarningRemovalSchedule,
} = require('./staff-settings-store');

const EXTEND_DURATIONS = Object.freeze({
  '30m': { label: '30 minutes', ms: 30 * 60 * 1000 },
  '1h': { label: '1 hour', ms: 60 * 60 * 1000 },
  '6h': { label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  '12h': { label: '12 hours', ms: 12 * 60 * 60 * 1000 },
  '1d': { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  '3d': { label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  '7d': { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  '14d': { label: '14 days', ms: 14 * 24 * 60 * 60 * 1000 },
  '30d': { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
});

function buildWarningActionRow(scheduleId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staffwarn:revoke:${scheduleId}`)
      .setLabel('Revoke')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`staffwarn:extend:${scheduleId}`)
      .setLabel('Extend')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildExtendSelect(scheduleId, messageId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`staffwarn:extendselect:${scheduleId}:${messageId}`)
      .setPlaceholder('How much time should be added?')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        Object.entries(EXTEND_DURATIONS).map(([value, item]) => ({
          label: `+ ${item.label}`,
          description: `Add ${item.label} to the current removal time`,
          value,
        })),
      ),
  );
}

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

function replaceEmbedField(embed, name, value) {
  const builder = EmbedBuilder.from(embed);
  const fields = [...(builder.data.fields || [])];
  const index = fields.findIndex((field) => field.name === name);

  const nextField = {
    name,
    value,
    inline: false,
  };

  if (index >= 0) {
    fields[index] = nextField;
  } else {
    fields.push(nextField);
  }

  builder.setFields(fields);
  return builder;
}

async function editWarningRemovalTime(message, executeAt) {
  if (!message?.embeds?.length) return;

  const unix = Math.floor(new Date(executeAt).getTime() / 1000);
  const embed = replaceEmbedField(
    message.embeds[0],
    'Automatic Removal',
    `<t:${unix}:F>\n**Removes <t:${unix}:R>**`,
  );

  await message.edit({
    embeds: [embed],
  });
}

async function markWarningRevoked(message, interaction, schedule) {
  if (!message?.embeds?.length) {
    await message.edit({ components: [] }).catch(() => {});
    return;
  }

  const embed = EmbedBuilder.from(message.embeds[0])
    .setColor(0x57f287)
    .setTitle('✅ Staff Warning Revoked');

  const fields = [...(embed.data.fields || [])].filter(
    (field) => field.name !== 'Automatic Removal' && field.name !== 'Status',
  );

  fields.push({
    name: 'Status',
    value:
      `Revoked by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>.\n` +
      `The warning role <@&${schedule.roleId}> was removed immediately.`,
    inline: false,
  });

  embed.setFields(fields);

  await message.edit({
    embeds: [embed],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function handleRevoke(interaction, scheduleId) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'Only an **Administrator** can revoke staff warnings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const schedule = await getWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
  );

  if (!schedule || schedule.status !== 'pending') {
    await interaction.editReply('This warning is no longer pending.');
    return;
  }

  const member = await interaction.guild.members
    .fetch(schedule.userId)
    .catch(() => null);
  const role =
    interaction.guild.roles.cache.get(schedule.roleId) ||
    (await interaction.guild.roles.fetch(schedule.roleId).catch(() => null));

  if (member && role && member.roles.cache.has(role.id)) {
    await member.roles.remove(
      role,
      `Warning revoked by ${interaction.user.tag}`,
    );
  }

  await revokeWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
    interaction.user.id,
  );

  await markWarningRevoked(
    interaction.message,
    interaction,
    schedule,
  );

  await interaction.editReply(
    `✅ Warning revoked. <@&${schedule.roleId}> was removed from <@${schedule.userId}> immediately.`,
  );
}

async function handleExtendButton(interaction, scheduleId) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'Only an **Administrator** can extend staff warnings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const schedule = await getWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
  );

  if (!schedule || schedule.status !== 'pending') {
    await interaction.reply({
      content: 'This warning is no longer pending.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      `Current removal: <t:${Math.floor(
        new Date(schedule.executeAt).getTime() / 1000,
      )}:F> (<t:${Math.floor(
        new Date(schedule.executeAt).getTime() / 1000,
      )}:R>)`,
    components: [
      buildExtendSelect(
        scheduleId,
        interaction.message.id,
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleExtendSelect(
  interaction,
  scheduleId,
  warningMessageId,
) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'Only an **Administrator** can extend staff warnings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const duration = EXTEND_DURATIONS[interaction.values[0]];

  if (!duration) {
    await interaction.update({
      content: 'That extension option is invalid.',
      components: [],
    });
    return;
  }

  const schedule = await getWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
  );

  if (!schedule || schedule.status !== 'pending') {
    await interaction.update({
      content: 'This warning is no longer pending.',
      components: [],
    });
    return;
  }

  const currentTime = new Date(schedule.executeAt).getTime();
  const newExecuteAt = new Date(currentTime + duration.ms);

  const updated = await updateWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
    newExecuteAt,
    interaction.user.id,
  );

  const warningMessage = await interaction.channel.messages
    .fetch(warningMessageId)
    .catch(() => null);

  if (warningMessage) {
    await editWarningRemovalTime(
      warningMessage,
      updated.executeAt,
    );
  }

  const unix = Math.floor(
    new Date(updated.executeAt).getTime() / 1000,
  );

  await interaction.update({
    content:
      `✅ Warning extended by **${duration.label}**.\n` +
      `New removal: <t:${unix}:F> (**<t:${unix}:R>**)`,
    components: [],
  });
}

async function handleWarningInteraction(interaction) {
  const customId = interaction.customId || '';

  if (!customId.startsWith('staffwarn:')) return false;
  if (!interaction.guild) return true;

  try {
    const parts = customId.split(':');
    const action = parts[1];

    if (action === 'revoke' && interaction.isButton()) {
      await handleRevoke(interaction, parts[2]);
      return true;
    }

    if (action === 'extend' && interaction.isButton()) {
      await handleExtendButton(interaction, parts[2]);
      return true;
    }

    if (
      action === 'extendselect' &&
      interaction.isStringSelectMenu()
    ) {
      await handleExtendSelect(
        interaction,
        parts[2],
        parts[3],
      );
      return true;
    }

    return true;
  } catch (error) {
    console.error('[STAFF WARNING INTERACTION ERROR]', error);

    const message =
      `I could not update that warning: ${error?.message || 'Unknown error'}`;

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: message,
        components: [],
      }).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    return true;
  }
}

module.exports = {
  buildWarningActionRow,
  handleWarningInteraction,
};
