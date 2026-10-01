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

async function findChannelMoveAuditEntry(
  guild,
  channelId,
  oldParentId,
  newParentId,
  eventTimestamp,
) {
  let newestTargetEntry =
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

    const exactMatch =
      candidates.find(
        (entry) =>
          parentChangeMatches(
            entry,
            oldParentId,
            newParentId,
          ),
      );

    if (exactMatch) {
      return exactMatch;
    }
  }

  return newestTargetEntry;
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

  if (
    oldParentId ===
      newParentId ||
    (
      !TRACKED_CATEGORY_IDS.has(
        oldParentId,
      ) &&
      !TRACKED_CATEGORY_IDS.has(
        newParentId,
      )
    )
  ) {
    return;
  }

  const guild =
    newChannel.guild ||
    oldChannel.guild;

  if (!guild) {
    return;
  }

  const eventTimestamp =
    Date.now();

  const auditEntry =
    await findChannelMoveAuditEntry(
      guild,
      newChannel.id,
      oldParentId,
      newParentId,
      eventTimestamp,
    );

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
        '📁 Channel Moved',
      )
      .setDescription(
        `<#${newChannel.id}> was moved between categories.`,
      )
      .addFields(
        {
          name:
            'Channel',
          value:
            `**Name:** ${newChannel.name}\n` +
            `**ID:** \`${newChannel.id}\``,
          inline:
            false,
        },
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
        {
          name:
            'Moved by',
          value:
            actorLabel(
              auditEntry,
            ),
          inline:
            false,
        },
      )
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
    `[CHANNEL MOVE LOGGER] ${newChannel.id}: ${oldParentId || 'none'} -> ${newParentId || 'none'} by ${auditEntry?.executor?.id || 'unknown'}.`,
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
