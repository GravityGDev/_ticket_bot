const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  getWarningRemovalSchedule,
  revokeWarningRemovalSchedule,
  saveWarningRevokeDetails,
  saveWarningExtensionDetails,
  updateWarningRemovalSchedule,
  getPendingWarningMessageSchedules,
  canManageStaffSettings,
  getStaffWarningHistory,
  hideWarningHistoryRecord,
  hideAllStaffWarningHistory,
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


function formatRemainingTime(executeAt, now = Date.now()) {
  let remaining = new Date(executeAt).getTime() - Number(now);

  if (!Number.isFinite(remaining) || remaining <= 0) {
    return 'removing now';
  }

  const totalMinutes = Math.max(1, Math.ceil(remaining / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];

  if (days) {
    parts.push(`${days} day${days === 1 ? '' : 's'}`);
  }
  if (hours) {
    parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  }
  if (minutes && parts.length < 2) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }

  return parts.slice(0, 2).join(' ') || 'less than 1 minute';
}

function buildRemovalFieldValue(executeAt) {
  const unix = Math.floor(new Date(executeAt).getTime() / 1000);

  // The database remains the source of truth for the automatic deadline, but
  // the warning embed only displays the exact removal date/time.
  return `<t:${unix}:F>`;
}

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


function buildRevokeReasonModal(scheduleId) {
  return new ModalBuilder()
    .setCustomId(`staffwarn:revokemodal:${scheduleId}`)
    .setTitle('Revoke Staff Warning')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason for revoking this warning')
          .setPlaceholder('Explain why this warning is being revoked...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(1000),
      ),
    );
}

function buildExtendReasonModal(
  scheduleId,
  warningMessageId,
  durationKey,
) {
  const duration = EXTEND_DURATIONS[durationKey];

  return new ModalBuilder()
    .setCustomId(
      `staffwarn:extendmodal:${scheduleId}:${warningMessageId}:${durationKey}`,
    )
    .setTitle(
      `Extend Warning +${duration?.label || 'Time'}`.slice(0, 45),
    )
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason for extending this warning')
          .setPlaceholder(
            'Explain why the warning removal time is being extended...',
          )
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(1000),
      ),
    );
}

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

function warningEmbedsWithPrimary(message, primaryEmbed) {
  const evidenceEmbeds = (message?.embeds || [])
    .slice(1)
    .map((embed) => EmbedBuilder.from(embed));

  return [
    primaryEmbed,
    ...evidenceEmbeds,
  ];
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

  const embed = replaceEmbedField(
    message.embeds[0],
    'Automatic Removal',
    buildRemovalFieldValue(executeAt),
  );

  await message.edit({
    embeds: warningEmbedsWithPrimary(message, embed),
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
    embeds: warningEmbedsWithPrimary(message, embed),
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

  await interaction.showModal(
    buildRevokeReasonModal(scheduleId),
  );
}

async function handleRevokeModal(interaction, scheduleId) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'Only an **Administrator** can revoke staff warnings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const revokeReason = interaction.fields
    .getTextInputValue('reason')
    .trim();

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const schedule = await getWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
  );

  if (!schedule || schedule.status !== 'pending') {
    await interaction.editReply(
      'This warning is no longer pending.',
    );
    return;
  }

  const member = await interaction.guild.members
    .fetch(schedule.userId)
    .catch(() => null);

  const role =
    interaction.guild.roles.cache.get(schedule.roleId) ||
    (await interaction.guild.roles
      .fetch(schedule.roleId)
      .catch(() => null));

  if (member && role && member.roles.cache.has(role.id)) {
    await member.roles.remove(
      role,
      `Warning revoked by ${interaction.user.tag}: ${revokeReason}`,
    );
  }

  const revoked = await saveWarningRevokeDetails(
    interaction.guild.id,
    scheduleId,
    interaction.user.id,
    revokeReason,
  );

  let warningMessage = null;

  if (revoked.channelId && revoked.messageId) {
    const channel =
      interaction.guild.channels.cache.get(revoked.channelId) ||
      (await interaction.guild.channels
        .fetch(revoked.channelId)
        .catch(() => null));

    if (channel?.isTextBased?.() && channel.messages?.fetch) {
      warningMessage = await channel.messages
        .fetch(revoked.messageId)
        .catch(() => null);
    }
  }

  if (warningMessage?.embeds?.length) {
    const embed = EmbedBuilder.from(warningMessage.embeds[0])
      .setColor(0x57f287)
      .setTitle('✅ Warning Revoked');

    const fields = [...(embed.data.fields || [])].filter(
      (field) =>
        field.name !== 'Automatic Removal' &&
        field.name !== 'Status' &&
        field.name !== 'Revoke Reason',
    );

    fields.push(
      {
        name: 'Revoke Reason',
        value: revokeReason,
        inline: false,
      },
      {
        name: 'Status',
        value:
          `Revoked by <@${interaction.user.id}> ` +
          `<t:${Math.floor(Date.now() / 1000)}:R>.\n` +
          `The warning role <@&${schedule.roleId}> was removed immediately.`,
        inline: false,
      },
    );

    embed.setFields(fields);

    await warningMessage.edit({
      embeds: warningEmbedsWithPrimary(warningMessage, embed),
      components: [],
      allowedMentions: { parse: [] },
    });
  }

  await interaction.editReply(
    '✅ Warning revoked. The revoke reason was saved and added to the warning embed.',
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

  const durationKey = interaction.values[0];
  const duration = EXTEND_DURATIONS[durationKey];

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

  await interaction.showModal(
    buildExtendReasonModal(
      scheduleId,
      warningMessageId,
      durationKey,
    ),
  );
}

async function handleExtendModal(
  interaction,
  scheduleId,
  warningMessageId,
  durationKey,
) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'Only an **Administrator** can extend staff warnings.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const duration = EXTEND_DURATIONS[durationKey];

  if (!duration) {
    await interaction.reply({
      content: 'That extension option is invalid.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const extensionReason = interaction.fields
    .getTextInputValue('reason')
    .trim();

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const schedule = await getWarningRemovalSchedule(
    interaction.guild.id,
    scheduleId,
  );

  if (!schedule || schedule.status !== 'pending') {
    await interaction.editReply(
      'This warning is no longer pending.',
    );
    return;
  }

  const currentTime = new Date(schedule.executeAt).getTime();
  const newExecuteAt = new Date(
    currentTime + duration.ms,
  );

  const updated = await saveWarningExtensionDetails(
    interaction.guild.id,
    scheduleId,
    newExecuteAt,
    interaction.user.id,
    extensionReason,
    duration.label,
  );

  let warningMessage = null;

  if (updated.channelId && updated.messageId) {
    const channel =
      interaction.guild.channels.cache.get(updated.channelId) ||
      (await interaction.guild.channels
        .fetch(updated.channelId)
        .catch(() => null));

    if (channel?.isTextBased?.() && channel.messages?.fetch) {
      warningMessage = await channel.messages
        .fetch(updated.messageId)
        .catch(() => null);
    }
  }

  if (!warningMessage && warningMessageId) {
    warningMessage = await interaction.channel.messages
      .fetch(warningMessageId)
      .catch(() => null);
  }

  const unix = Math.floor(
    new Date(updated.executeAt).getTime() / 1000,
  );

  if (warningMessage?.embeds?.length) {
    let embed = replaceEmbedField(
      warningMessage.embeds[0],
      'Automatic Removal',
      `<t:${unix}:F>`,
    );

    const fields = [...(embed.data.fields || [])].filter(
      (field) => field.name !== 'Latest Extension',
    );

    fields.push({
      name: 'Latest Extension',
      value:
        `**Extended by:** <@${interaction.user.id}>\n` +
        `**Time added:** ${duration.label}\n` +
        `**Reason:** ${extensionReason}\n` +
        `**New removal:** <t:${unix}:F>`,
      inline: false,
    });

    embed.setFields(fields);

    await warningMessage.edit({
      embeds: warningEmbedsWithPrimary(warningMessage, embed),
      allowedMentions: { parse: [] },
    });
  }

  await interaction.editReply(
    `✅ Warning extended by **${duration.label}**. The reason was saved and added to the warning embed.`,
  );
}

async function fetchWarningMessage(client, schedule) {
  const guild =
    client.guilds.cache.get(String(schedule.guildId)) ||
    (await client.guilds.fetch(String(schedule.guildId)).catch(() => null));

  if (!guild) return null;

  const channel =
    guild.channels.cache.get(String(schedule.channelId)) ||
    (await guild.channels.fetch(String(schedule.channelId)).catch(() => null));

  if (
    !channel ||
    !channel.isTextBased?.() ||
    !channel.messages?.fetch
  ) {
    return null;
  }

  return channel.messages
    .fetch(String(schedule.messageId))
    .catch(() => null);
}

async function refreshWarningCountdowns(client) {
  const schedules = await getPendingWarningMessageSchedules(500);

  let updatedCount = 0;

  for (const schedule of schedules) {
    try {
      const message = await fetchWarningMessage(client, schedule);
      if (!message?.embeds?.length) continue;

      const currentEmbed = message.embeds[0];
      const automaticRemoval = currentEmbed.fields?.find(
        (field) => field.name === 'Automatic Removal',
      );

      const desiredValue = buildRemovalFieldValue(schedule.executeAt);

      // Avoid unnecessary Discord edits when the visible minute text has not
      // changed since the previous scheduler pass.
      if (automaticRemoval?.value === desiredValue) continue;

      const embed = replaceEmbedField(
        currentEmbed,
        'Automatic Removal',
        desiredValue,
      );

      await message.edit({
        embeds: warningEmbedsWithPrimary(message, embed),
      });

      updatedCount += 1;
    } catch (error) {
      console.error(
        `[WARNING COUNTDOWN UPDATE ERROR] schedule=${schedule._id}`,
        error,
      );
    }
  }

  if (updatedCount) {
    console.log(
      `[WARNING COUNTDOWN] Refreshed ${updatedCount} warning message(s) from MongoDB.`,
    );
  }

  return updatedCount;
}

async function markWarningAutomaticallyRemoved(client, schedule) {
  if (!schedule?.channelId || !schedule?.messageId) return false;

  try {
    const message = await fetchWarningMessage(client, schedule);
    if (!message) return false;

    if (!message.embeds?.length) {
      await message.edit({ components: [] }).catch(() => {});
      return true;
    }

    const completedUnix = Math.floor(Date.now() / 1000);
    const embed = EmbedBuilder.from(message.embeds[0])
      .setColor(0x57f287)
      .setTitle('✅ Warning Removed');

    const fields = [...(embed.data.fields || [])].filter(
      (field) =>
        field.name !== 'Automatic Removal' &&
        field.name !== 'Status',
    );

    fields.push({
      name: 'Status',
      value:
        `✅ **Warning removed automatically.**\n` +
        `The scheduled removal time was reached <t:${completedUnix}:R>.\n` +
        `The warning role <@&${schedule.roleId}> has been removed from <@${schedule.userId}>.`,
      inline: false,
    });

    embed.setFields(fields);

    await message.edit({
      embeds: warningEmbedsWithPrimary(message, embed),
      components: [],
      allowedMentions: { parse: [] },
    });

    return true;
  } catch (error) {
    console.error(
      `[WARNING AUTO-REMOVED MESSAGE ERROR] schedule=${schedule?._id}`,
      error,
    );
    return false;
  }
}


const WARNING_HISTORY_PAGE_SIZE = 5;

function truncateHistoryText(value, max = 260) {
  const content = String(value || '').trim();

  if (!content) return 'Not recorded';

  return content.length <= max
    ? content
    : `${content.slice(0, Math.max(1, max - 1))}…`;
}

function warningStatusLabel(warning) {
  switch (warning.status) {
    case 'pending':
      return '🟠 Active';
    case 'processing':
      return '🟡 Removing';
    case 'completed':
      return '✅ Removed';
    case 'revoked':
      return '🟢 Revoked';
    case 'failed':
      return '🔴 Removal Failed';
    default:
      return `⚪ ${String(warning.status || 'Unknown')}`;
  }
}

function warningTime(value, style = 'f') {
  const date = value instanceof Date
    ? value
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function warningEvidenceText(warning) {
  if (!Array.isArray(warning.evidence) || !warning.evidence.length) {
    return null;
  }

  const links = warning.evidence
    .slice(0, 5)
    .map(
      (item, index) =>
        `[Image ${index + 1}](${item.url})`,
    )
    .join(' • ');

  return `**Evidence:** ${links}`;
}

function warningHistoryEntry(warning, number) {
  const lines = [
    `**Status:** ${warningStatusLabel(warning)}`,
    `**Warning Role:** <@&${warning.roleId}>`,
    `**Issued:** ${warningTime(warning.createdAt, 'f')} (${warningTime(warning.createdAt, 'R')})`,
    `**Issued By:** <@${warning.createdBy}>`,
    `**Reason:** ${truncateHistoryText(warning.reason, 320)}`,
  ];

  const evidenceText = warningEvidenceText(warning);

  if (evidenceText) {
    lines.push(evidenceText);
  }

  if (
    warning.status === 'pending' ||
    warning.status === 'processing'
  ) {
    lines.push(
      `**Scheduled Removal:** ${warningTime(warning.executeAt, 'f')}`,
    );
  }

  if (warning.status === 'completed') {
    lines.push(
      `**Removed:** ${warningTime(
        warning.finishedAt || warning.executeAt,
        'f',
      )}`,
    );
  }

  if (warning.status === 'revoked') {
    lines.push(
      `**Revoked By:** <@${warning.revokedBy || warning.updatedBy}>`,
      `**Revoked:** ${warningTime(
        warning.revokedAt || warning.finishedAt,
        'f',
      )}`,
      `**Revoke Reason:** ${truncateHistoryText(
        warning.revokeReason,
        320,
      )}`,
    );
  }

  if (warning.status === 'failed') {
    lines.push(
      `**Removal Error:** ${truncateHistoryText(
        warning.error,
        260,
      )}`,
    );
  }

  if (warning.lastExtendedAt) {
    lines.push(
      `**Latest Extension:** +${warning.lastExtensionAmount || 'time'} by <@${warning.lastExtendedBy}>`,
      `**Extension Reason:** ${truncateHistoryText(
        warning.lastExtensionReason,
        280,
      )}`,
    );
  }

  return {
    name: `${number}. ${warningStatusLabel(warning)}`,
    value: lines.join('\n').slice(0, 1024),
    inline: false,
  };
}

function buildHistoryPageButtons(
  userId,
  page,
  pageCount,
) {
  const previousPage = Math.max(0, page - 1);
  const nextPage = Math.min(
    Math.max(0, pageCount - 1),
    page + 1,
  );

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `staffwarn:historypage:${userId}:${previousPage}:prev`,
      )
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(
        `staffwarn:historynoop:${userId}:${page}`,
      )
      .setLabel(`Page ${page + 1}/${pageCount}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(
        `staffwarn:historypage:${userId}:${nextPage}:next`,
      )
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );
}

function buildHistoryEditorControls(
  userId,
  page,
  warnings,
) {
  const components = [];

  if (warnings.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(
            `staffwarn:historypick:${userId}:${page}`,
          )
          .setPlaceholder('Select a warning to remove from history')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            warnings.map((warning, index) => ({
              label: `Warning ${page * WARNING_HISTORY_PAGE_SIZE + index + 1}`,
              description: truncateHistoryText(
                `${warningStatusLabel(warning)} • ${warning.reason || 'No reason'}`,
                95,
              ),
              value: String(warning._id),
            })),
          ),
      ),
    );
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `staffwarn:historyremoveall:${userId}:${page}`,
        )
        .setLabel('Remove All History')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!warnings.length),
    ),
  );

  return components;
}

async function buildWarningHistoryPayload(
  guild,
  targetMember,
  viewerId,
  requestedPage = 0,
) {
  const history = await getStaffWarningHistory(
    guild.id,
    targetMember.id,
    {
      page: requestedPage,
      pageSize: WARNING_HISTORY_PAGE_SIZE,
    },
  );

  const canEditHistory = await canManageStaffSettings(
    guild.id,
    viewerId,
  );

  const firstNumber =
    history.page * WARNING_HISTORY_PAGE_SIZE + 1;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name:
        targetMember.displayName ||
        targetMember.user.username,
      iconURL: targetMember.user.displayAvatarURL({
        size: 128,
      }),
    })
    .setTitle('⚠️ Staff Warning History')
    .setDescription(
      `<@${targetMember.id}> has **${history.total}** warning${
        history.total === 1 ? '' : 's'
      } on record.`,
    )
    .setFooter({
      text:
        `Showing up to ${WARNING_HISTORY_PAGE_SIZE} warnings per page` +
        (canEditHistory
          ? ' • You can manage this history'
          : ''),
    })
    .setTimestamp();

  if (history.warnings.length) {
    embed.addFields(
      ...history.warnings.map((warning, index) =>
        warningHistoryEntry(
          warning,
          firstNumber + index,
        ),
      ),
    );
  } else {
    embed.addFields({
      name: 'No Warning History',
      value: 'This staff member has no warnings on record.',
    });
  }

  const components = [
    buildHistoryPageButtons(
      targetMember.id,
      history.page,
      history.pageCount,
    ),
  ];

  if (canEditHistory) {
    components.push(
      ...buildHistoryEditorControls(
        targetMember.id,
        history.page,
        history.warnings,
      ),
    );
  }

  return {
    embeds: [embed],
    components,
  };
}

async function getHistoryTargetMember(
  guild,
  userId,
) {
  return guild.members
    .fetch(userId)
    .catch(() => null);
}

async function assertHistoryEditor(interaction) {
  const allowed = await canManageStaffSettings(
    interaction.guild.id,
    interaction.user.id,
  );

  if (!allowed) {
    await interaction.reply({
      content:
        'Only Staff Stats **Settings Editors** can remove warning history.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return false;
  }

  return true;
}

async function handleHistoryPage(
  interaction,
  userId,
  requestedPage,
) {
  const member = await getHistoryTargetMember(
    interaction.guild,
    userId,
  );

  if (!member) {
    await interaction.update({
      content:
        'That staff member is no longer available in this server.',
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update(
    await buildWarningHistoryPayload(
      interaction.guild,
      member,
      interaction.user.id,
      Number(requestedPage) || 0,
    ),
  );
}

async function handleHistoryPick(
  interaction,
  userId,
  page,
) {
  if (!(await assertHistoryEditor(interaction))) {
    return;
  }

  const warningId = interaction.values[0];

  await interaction.update({
    content:
      'Remove this warning from the staff member’s tracked history?\n\n' +
      '**This only removes the history record from `/warnings`. ' +
      'If the warning is still active, its automatic role-removal schedule continues normally.**',
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `staffwarn:historyremoveone:${userId}:${page}:${warningId}`,
          )
          .setLabel('Remove This Warning')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(
            `staffwarn:historypage:${userId}:${page}:back`,
          )
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleHistoryRemoveOne(
  interaction,
  userId,
  page,
  warningId,
) {
  if (!(await assertHistoryEditor(interaction))) {
    return;
  }

  await hideWarningHistoryRecord(
    interaction.guild.id,
    warningId,
    interaction.user.id,
  );

  const member = await getHistoryTargetMember(
    interaction.guild,
    userId,
  );

  if (!member) {
    await interaction.update({
      content: 'Warning removed from history.',
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update(
    await buildWarningHistoryPayload(
      interaction.guild,
      member,
      interaction.user.id,
      Number(page) || 0,
    ),
  );
}

async function handleHistoryRemoveAllPrompt(
  interaction,
  userId,
  page,
) {
  if (!(await assertHistoryEditor(interaction))) {
    return;
  }

  await interaction.update({
    content:
      'Remove **all warning history** for this staff member?\n\n' +
      '**Active warning roles and automatic removal schedules will continue; only their tracked history will be hidden.**',
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `staffwarn:historyremoveallconfirm:${userId}:${page}`,
          )
          .setLabel('Remove All History')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(
            `staffwarn:historypage:${userId}:${page}:back`,
          )
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function handleHistoryRemoveAllConfirm(
  interaction,
  userId,
) {
  if (!(await assertHistoryEditor(interaction))) {
    return;
  }

  await hideAllStaffWarningHistory(
    interaction.guild.id,
    userId,
    interaction.user.id,
  );

  const member = await getHistoryTargetMember(
    interaction.guild,
    userId,
  );

  if (!member) {
    await interaction.update({
      content: 'All warning history was removed.',
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.update(
    await buildWarningHistoryPayload(
      interaction.guild,
      member,
      interaction.user.id,
      0,
    ),
  );
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

    if (
      action === 'revokemodal' &&
      interaction.isModalSubmit()
    ) {
      await handleRevokeModal(
        interaction,
        parts[2],
      );
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

    if (
      action === 'extendmodal' &&
      interaction.isModalSubmit()
    ) {
      await handleExtendModal(
        interaction,
        parts[2],
        parts[3],
        parts[4],
      );
      return true;
    }

    if (
      action === 'historynoop' &&
      interaction.isButton()
    ) {
      await interaction.deferUpdate().catch(() => {});
      return true;
    }

    if (
      action === 'historypage' &&
      interaction.isButton()
    ) {
      await handleHistoryPage(
        interaction,
        parts[2],
        parts[3],
      );
      return true;
    }

    if (
      action === 'historypick' &&
      interaction.isStringSelectMenu()
    ) {
      await handleHistoryPick(
        interaction,
        parts[2],
        parts[3],
      );
      return true;
    }

    if (
      action === 'historyremoveone' &&
      interaction.isButton()
    ) {
      await handleHistoryRemoveOne(
        interaction,
        parts[2],
        parts[3],
        parts[4],
      );
      return true;
    }

    if (
      action === 'historyremoveall' &&
      interaction.isButton()
    ) {
      await handleHistoryRemoveAllPrompt(
        interaction,
        parts[2],
        parts[3],
      );
      return true;
    }

    if (
      action === 'historyremoveallconfirm' &&
      interaction.isButton()
    ) {
      await handleHistoryRemoveAllConfirm(
        interaction,
        parts[2],
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
  buildRemovalFieldValue,
  refreshWarningCountdowns,
  markWarningAutomaticallyRemoved,
  buildWarningHistoryPayload,
  handleWarningInteraction,
};
