const {
  AuditLogEvent,
  EmbedBuilder,
  Events,
} = require('discord.js');

const TRACKED_CATEGORY_IDS = new Set([
  '1194041227146965093',
]);

const CHANNEL_UPDATE_LOG_ID =
  '1203758463197651006';

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

function actorLabel(
  auditEntry,
) {
  const executor =
    auditEntry?.executor;

  if (!executor) {
    return (
      'Unknown — the bot could not match a recent audit-log entry. ' +
      'Check that it has **View Audit Log** permission.'
    );
  }

  return (
    `<@${executor.id}>\n` +
    `**User:** ${executor.tag || executor.username}\n` +
    `**ID:** \`${executor.id}\``
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

  await logChannel.send({
    embeds: [
      embed,
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
