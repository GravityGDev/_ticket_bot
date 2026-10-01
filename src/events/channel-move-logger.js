const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  escapeMarkdown,
} = require('discord.js');

const TRACKED_CATEGORY_IDS = new Set([
  '1194041227146965093',
]);

const CHANNEL_UPDATE_LOG_ID =
  '1203758463197651006';

const CHANNEL_MOVE_REVERT_ROLE_ID =
  '950141448307740672';

const CHANNEL_MOVE_REVERT_PREFIX =
  'cmr';

const REVERT_AUDIT_REASON_PREFIX =
  'Channel move reverted by';

const activeReverts =
  new Set();

const AUDIT_LOOKUP_DELAYS_MS = [
  350,
  700,
  1200,
];

const AUDIT_MATCH_WINDOW_MS =
  15 * 1000;

const RECENT_LOG_TTL_MS =
  20 * 1000;

const recentMoveLogs =
  new Map();

function wait(milliseconds) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds,
      ),
  );
}

function normalizeNullableId(value) {
  const id =
    String(
      value ||
      '',
    ).trim();

  return id || null;
}

function channelPosition(channel) {
  const rawPosition =
    Number(
      channel?.rawPosition,
    );

  if (
    Number.isInteger(
      rawPosition,
    )
  ) {
    return rawPosition;
  }

  const position =
    Number(
      channel?.position,
    );

  return Number.isInteger(
    position,
  )
    ? position
    : null;
}

function parentChangeMatches(
  entry,
  oldParentId,
  newParentId,
) {
  return Boolean(
    entry?.changes?.some(
      (change) =>
        change.key ===
          'parent_id' &&
        normalizeNullableId(
          change.old,
        ) ===
          normalizeNullableId(
            oldParentId,
          ) &&
        normalizeNullableId(
          change.new,
        ) ===
          normalizeNullableId(
            newParentId,
          ),
    ),
  );
}

function positionChangeMatches(
  entry,
  oldPosition,
  newPosition,
) {
  return Boolean(
    entry?.changes?.some(
      (change) => {
        if (
          change.key !==
            'position'
        ) {
          return false;
        }

        const auditOld =
          Number(
            change.old,
          );

        const auditNew =
          Number(
            change.new,
          );

        if (
          Number.isInteger(
            auditOld,
          ) &&
          Number.isInteger(
            auditNew,
          )
        ) {
          return (
            auditOld ===
              oldPosition &&
            auditNew ===
              newPosition
          );
        }

        return true;
      },
    ),
  );
}

async function findChannelMoveAuditEntry(
  guild,
  channelId,
  movementType,
  oldParentId,
  newParentId,
  oldPosition,
  newPosition,
  eventTimestamp,
) {
  let newestTargetEntry =
    null;

  let newestPositionEntry =
    null;

  for (
    const delay of
    AUDIT_LOOKUP_DELAYS_MS
  ) {
    await wait(
      delay,
    );

    let auditLogs;

    try {
      auditLogs =
        await guild.fetchAuditLogs({
          type:
            AuditLogEvent.ChannelUpdate,
          limit:
            10,
        });
    } catch (error) {
      console.error(
        '[CHANNEL MOVE AUDIT LOG READ ERROR]',
        error,
      );

      return null;
    }

    const candidates =
      [
        ...auditLogs.entries.values(),
      ]
        .filter(
          (entry) =>
            String(
              entry.target?.id ||
              '',
            ) ===
              String(
                channelId,
              ) &&
            Math.abs(
              eventTimestamp -
              entry.createdTimestamp,
            ) <=
              AUDIT_MATCH_WINDOW_MS,
        )
        .sort(
          (a, b) =>
            b.createdTimestamp -
            a.createdTimestamp,
        );

    if (
      candidates.length &&
      !newestTargetEntry
    ) {
      newestTargetEntry =
        candidates[0];
    }

    if (
      !newestPositionEntry
    ) {
      newestPositionEntry =
        candidates.find(
          (entry) =>
            entry?.changes?.some(
              (change) =>
                change.key ===
                  'position',
            ),
        ) ||
        null;
    }

    const exactMatch =
      candidates.find(
        (entry) =>
          movementType ===
            'category'
            ? parentChangeMatches(
                entry,
                oldParentId,
                newParentId,
              )
            : positionChangeMatches(
                entry,
                oldPosition,
                newPosition,
              ),
      );

    if (exactMatch) {
      return exactMatch;
    }
  }

  // A category transfer is still useful to log if Discord omitted the parent
  // change details. For same-category reorders, require a position audit entry
  // so automatic shifts of neighbouring channels do not create false logs.
  return movementType ===
    'category'
    ? newestTargetEntry
    : newestPositionEntry;
}

function categoryLabel(
  guild,
  categoryId,
) {
  if (!categoryId) {
    return 'No category';
  }

  const category =
    guild.channels.cache.get(
      categoryId,
    );

  return (
    `<#${categoryId}>\n` +
    `**Name:** ${category?.name || 'Unknown category'}\n` +
    `**ID:** \`${categoryId}\``
  );
}

function displayAndUsername(
  user,
  member,
) {
  const username =
    user?.username ||
    member?.user?.username ||
    'Unknown username';

  const displayName =
    member?.displayName ||
    user?.globalName ||
    username;

  return (
    `${escapeMarkdown(String(displayName))} - ` +
    escapeMarkdown(String(username))
  );
}

function actorLabel(
  auditEntry,
  executorMember,
) {
  const executor =
    auditEntry?.executor ||
    executorMember?.user ||
    null;

  const executorId =
    executor?.id ||
    auditEntry?.executorId ||
    executorMember?.id ||
    null;

  if (!executorId) {
    return (
      'Unknown — the bot could not match a recent audit-log entry. ' +
      'Check that it has **View Audit Log** permission.'
    );
  }

  return (
    `<@${executorId}>\n` +
    `**Name:** ${displayAndUsername(executor, executorMember)}\n` +
    `**ID:** \`${executorId}\``
  );
}

function moveDirection(
  oldPosition,
  newPosition,
) {
  if (
    newPosition <
      oldPosition
  ) {
    return 'up';
  }

  if (
    newPosition >
      oldPosition
  ) {
    return 'down';
  }

  return 'within the category';
}

function isDuplicateMoveLog(
  auditEntry,
  channelId,
  oldParentId,
  newParentId,
  oldPosition,
  newPosition,
) {
  const now =
    Date.now();

  for (
    const [
      key,
      createdAt,
    ] of recentMoveLogs
  ) {
    if (
      now -
        createdAt >
      RECENT_LOG_TTL_MS
    ) {
      recentMoveLogs.delete(
        key,
      );
    }
  }

  const key =
    auditEntry?.id
      ? `audit:${auditEntry.id}`
      : (
          `event:${channelId}:` +
          `${oldParentId || 'none'}:${newParentId || 'none'}:` +
          `${oldPosition ?? 'none'}:${newPosition ?? 'none'}`
        );

  if (
    recentMoveLogs.has(
      key,
    )
  ) {
    return true;
  }

  recentMoveLogs.set(
    key,
    now,
  );

  return false;
}

function buildChannelMoveRevertCustomId({
  channelId,
  oldParentId,
  newParentId,
  oldPosition,
  newPosition,
}) {
  return [
    CHANNEL_MOVE_REVERT_PREFIX,
    String(channelId),
    oldParentId || '0',
    newParentId || '0',
    Number.isInteger(oldPosition)
      ? String(oldPosition)
      : '-1',
    Number.isInteger(newPosition)
      ? String(newPosition)
      : '-1',
  ].join(':');
}

function parseChannelMoveRevertCustomId(
  customId,
) {
  const parts =
    String(customId || '')
      .split(':');

  if (
    parts.length !== 6 ||
    parts[0] !==
      CHANNEL_MOVE_REVERT_PREFIX
  ) {
    return null;
  }

  const [
    ,
    channelId,
    oldParentValue,
    newParentValue,
    oldPositionValue,
    newPositionValue,
  ] = parts;

  if (
    !/^\d{17,20}$/.test(
      channelId,
    ) ||
    !/^(0|\d{17,20})$/.test(
      oldParentValue,
    ) ||
    !/^(0|\d{17,20})$/.test(
      newParentValue,
    ) ||
    !/^-?\d+$/.test(
      oldPositionValue,
    ) ||
    !/^-?\d+$/.test(
      newPositionValue,
    )
  ) {
    return null;
  }

  return {
    channelId,
    oldParentId:
      oldParentValue === '0'
        ? null
        : oldParentValue,
    newParentId:
      newParentValue === '0'
        ? null
        : newParentValue,
    oldPosition:
      Number(oldPositionValue),
    newPosition:
      Number(newPositionValue),
  };
}

function buildChannelMoveRevertRow(
  customId,
  disabled = false,
) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          customId,
        )
        .setLabel(
          disabled
            ? 'Reverted'
            : 'Revert',
        )
        .setEmoji('↩️')
        .setStyle(
          disabled
            ? ButtonStyle.Success
            : ButtonStyle.Secondary,
        )
        .setDisabled(
          disabled,
        ),
    );
}

async function handleChannelMoveRevertInteraction(
  interaction,
) {
  if (
    !interaction.isButton?.() ||
    !String(
      interaction.customId ||
      '',
    ).startsWith(
      `${CHANNEL_MOVE_REVERT_PREFIX}:`,
    )
  ) {
    return;
  }

  const move =
    parseChannelMoveRevertCustomId(
      interaction.customId,
    );

  if (
    !move ||
    !interaction.guild ||
    interaction.channelId !==
      CHANNEL_UPDATE_LOG_ID
  ) {
    await interaction.reply({
      content:
        'This channel-move revert control is invalid.',
      flags:
        MessageFlags.Ephemeral,
    }).catch(() => {});

    return;
  }

  const member =
    await interaction.guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null);

  if (
    !member?.roles?.cache?.has(
      CHANNEL_MOVE_REVERT_ROLE_ID,
    )
  ) {
    await interaction.reply({
      content:
        `Only <@&${CHANNEL_MOVE_REVERT_ROLE_ID}> can revert channel moves.`,
      flags:
        MessageFlags.Ephemeral,
      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  if (
    activeReverts.has(
      interaction.customId,
    )
  ) {
    await interaction.reply({
      content:
        'That channel move is already being reverted.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const channel =
    interaction.guild.channels.cache.get(
      move.channelId,
    ) ||
    (await interaction.guild.channels
      .fetch(
        move.channelId,
      )
      .catch(() => null));

  if (
    !channel ||
    typeof channel.setParent !==
      'function' ||
    typeof channel.setPosition !==
      'function'
  ) {
    await interaction.reply({
      content:
        'I could not find or manage the channel from this log.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  const currentParentId =
    normalizeNullableId(
      channel.parentId,
    );

  const currentPosition =
    channelPosition(
      channel,
    );

  const movedBetweenCategories =
    move.oldParentId !==
      move.newParentId;

  const stillMatchesLoggedMove =
    currentParentId ===
      move.newParentId &&
    (
      movedBetweenCategories ||
      currentPosition ===
        move.newPosition
    );

  if (
    !stillMatchesLoggedMove
  ) {
    await interaction.reply({
      content:
        'I did not revert this move because the channel has changed again since this log was created.',
      flags:
        MessageFlags.Ephemeral,
    });

    return;
  }

  activeReverts.add(
    interaction.customId,
  );

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  const reason =
    `${REVERT_AUDIT_REASON_PREFIX} ${interaction.user.tag} (${interaction.user.id})`;

  try {
    if (
      movedBetweenCategories
    ) {
      await channel.setParent(
        move.oldParentId,
        {
          lockPermissions:
            false,
          reason,
        },
      );

      if (
        move.oldPosition >=
          0
      ) {
        await channel.setPosition(
          move.oldPosition,
          {
            reason,
          },
        );
      }
    } else {
      if (
        move.oldPosition <
          0
      ) {
        throw new Error(
          'The original channel position was not recorded.',
        );
      }

      await channel.setPosition(
        move.oldPosition,
        {
          reason,
        },
      );
    }

    const revertedEmbed =
      interaction.message.embeds[0]
        ? EmbedBuilder.from(
            interaction.message.embeds[0],
          )
            .setColor(
              0x57f287,
            )
            .addFields({
              name:
                'Reverted by',
              value:
                `<@${interaction.user.id}>\n` +
                `**Name:** ${displayAndUsername(interaction.user, member)}\n` +
                `**ID:** \`${interaction.user.id}\``,
              inline:
                false,
            })
        : null;

    await interaction.message.edit({
      ...(revertedEmbed
        ? {
            embeds: [
              revertedEmbed,
            ],
          }
        : {}),
      components: [
        buildChannelMoveRevertRow(
          interaction.customId,
          true,
        ),
      ],
      allowedMentions: {
        parse: [],
      },
    });

    await interaction.editReply({
      content:
        `Reverted the logged move for <#${channel.id}>.`,
      allowedMentions: {
        parse: [],
      },
    });

    console.log(
      `[CHANNEL MOVE REVERT] ${channel.id} reverted by ${interaction.user.id}.`,
    );
  } catch (error) {
    console.error(
      '[CHANNEL MOVE REVERT ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        'I could not revert that channel move. Check my **Manage Channels** permission and try again.',
    }).catch(() => {});
  } finally {
    activeReverts.delete(
      interaction.customId,
    );
  }
}

async function sendChannelMoveLog(
  oldChannel,
  newChannel,
) {
  const oldParentId =
    normalizeNullableId(
      oldChannel.parentId,
    );

  const newParentId =
    normalizeNullableId(
      newChannel.parentId,
    );

  const oldPosition =
    channelPosition(
      oldChannel,
    );

  const newPosition =
    channelPosition(
      newChannel,
    );

  const movedBetweenCategories =
    oldParentId !==
      newParentId &&
    (
      TRACKED_CATEGORY_IDS.has(
        oldParentId,
      ) ||
      TRACKED_CATEGORY_IDS.has(
        newParentId,
      )
    );

  const reorderedInsideCategory =
    oldParentId ===
      newParentId &&
    TRACKED_CATEGORY_IDS.has(
      newParentId,
    ) &&
    oldPosition !==
      null &&
    newPosition !==
      null &&
    oldPosition !==
      newPosition;

  if (
    !movedBetweenCategories &&
    !reorderedInsideCategory
  ) {
    return;
  }

  const guild =
    newChannel.guild ||
    oldChannel.guild;

  if (!guild) {
    return;
  }

  const movementType =
    movedBetweenCategories
      ? 'category'
      : 'position';

  const eventTimestamp =
    Date.now();

  const auditEntry =
    await findChannelMoveAuditEntry(
      guild,
      newChannel.id,
      movementType,
      oldParentId,
      newParentId,
      oldPosition,
      newPosition,
      eventTimestamp,
    );

  const isBotGeneratedRevert =
    auditEntry?.executor?.id ===
      guild.members.me?.id &&
    String(
      auditEntry?.reason ||
      '',
    ).startsWith(
      REVERT_AUDIT_REASON_PREFIX,
    );

  if (
    isBotGeneratedRevert
  ) {
    return;
  }

  if (
    movementType ===
      'position' &&
    !auditEntry
  ) {
    console.warn(
      `[CHANNEL MOVE LOGGER] Ignored unmatched position shift for ${newChannel.id}; it may be a neighbouring channel moved automatically by Discord.`,
    );

    return;
  }

  if (
    isDuplicateMoveLog(
      auditEntry,
      newChannel.id,
      oldParentId,
      newParentId,
      oldPosition,
      newPosition,
    )
  ) {
    return;
  }

  const executorId =
    auditEntry?.executor?.id ||
    auditEntry?.executorId ||
    null;

  const executorMember =
    executorId
      ? (
          guild.members.cache.get(
            executorId,
          ) ||
          (await guild.members
            .fetch(
              executorId,
            )
            .catch(() => null))
        )
      : null;

  const logChannel =
    guild.channels.cache.get(
      CHANNEL_UPDATE_LOG_ID,
    ) ||
    (await guild.channels
      .fetch(
        CHANNEL_UPDATE_LOG_ID,
      )
      .catch(() => null));

  if (
    !logChannel?.isTextBased?.() ||
    typeof logChannel.send !==
      'function'
  ) {
    console.error(
      `[CHANNEL MOVE LOGGER] Log channel ${CHANNEL_UPDATE_LOG_ID} is unavailable or not sendable.`,
    );

    return;
  }

  const embed =
    new EmbedBuilder()
      .setColor(
        0xfee75c,
      )
      .setTitle(
        movementType ===
          'category'
          ? '📁 Channel Moved'
          : '↕️ Channel Order Changed',
      )
      .setDescription(
        movementType ===
          'category'
          ? `<#${newChannel.id}> was moved between categories.`
          : (
              `<#${newChannel.id}> was moved **` +
              `${moveDirection(oldPosition, newPosition)}** inside ` +
              `<#${newParentId}>.`
            ),
      )
      .addFields({
        name:
          'Channel',
        value:
          `**Name:** ${newChannel.name}\n` +
          `**ID:** \`${newChannel.id}\``,
        inline:
          false,
      });

  if (
    movementType ===
      'category'
  ) {
    embed.addFields(
      {
        name:
          'Previous category',
        value:
          categoryLabel(
            guild,
            oldParentId,
          ),
        inline:
          true,
      },
      {
        name:
          'New category',
        value:
          categoryLabel(
            guild,
            newParentId,
          ),
        inline:
          true,
      },
    );
  } else {
    embed.addFields(
      {
        name:
          'Category',
        value:
          categoryLabel(
            guild,
            newParentId,
          ),
        inline:
          false,
      },
      {
        name:
          'Previous position',
        value:
          `#${oldPosition + 1}`,
        inline:
          true,
      },
      {
        name:
          'New position',
        value:
          `#${newPosition + 1}`,
        inline:
          true,
      },
    );
  }

  embed
    .addFields({
      name:
        'Moved by',
      value:
        actorLabel(
          auditEntry,
          executorMember,
        ),
      inline:
        false,
    })
    .setTimestamp(
      new Date(
        eventTimestamp,
      ),
    )
    .setFooter({
      text:
        'Snay.io channel update tracking',
    });

  if (auditEntry?.reason) {
    embed.addFields({
      name:
        'Audit reason',
      value:
        String(
          auditEntry.reason,
        ).slice(
          0,
          1024,
        ),
      inline:
        false,
    });
  }

  const revertCustomId =
    buildChannelMoveRevertCustomId({
      channelId:
        newChannel.id,
      oldParentId,
      newParentId,
      oldPosition,
      newPosition,
    });

  await logChannel.send({
    embeds: [
      embed,
    ],
    components: [
      buildChannelMoveRevertRow(
        revertCustomId,
      ),
    ],
    allowedMentions: {
      parse: [],
    },
  });

  console.log(
    `[CHANNEL MOVE LOGGER] ${newChannel.id}: ` +
    `${movementType === 'category' ? `${oldParentId || 'none'} -> ${newParentId || 'none'}` : `position ${oldPosition} -> ${newPosition}`} ` +
    `by ${auditEntry?.executor?.id || 'unknown'}.`,
  );
}

module.exports = {
  handleChannelMoveRevertInteraction,

  name:
    Events.ChannelUpdate,

  async execute(
    oldChannel,
    newChannel,
  ) {
    try {
      await sendChannelMoveLog(
        oldChannel,
        newChannel,
      );
    } catch (error) {
      console.error(
        '[CHANNEL MOVE LOGGER ERROR]',
        error,
      );
    }
  },
};
