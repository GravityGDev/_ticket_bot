const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getMongoDb } = require('./database');
const {
  canMemberUseCommandSync,
} = require('./staff-command-permissions');
const {
  notifyRestoreReactionBot,
} = require('./restore-reaction-webhook');

const SKIN_REVIEW_CHANNEL_ID = '1193625435796422657';
const SOURCE_MEDIA_BOT_ID = '891220330817912852';
const PROTECTED_REACTION_BOT_ID = SOURCE_MEDIA_BOT_ID;
const PAGE_SIZE = 5;
const APPROVE_EMOJI = '✔️';
const REJECT_EMOJI = '❌';

const FILTER_ALL = 'all';
const FILTER_SKINS = 'skins';
const FILTER_BADGES = 'badges';
const FILTER_APPROVED = 'approved';
const FILTER_REJECTED = 'rejected';
const BLACKLIST_MANAGER_PAGE_SIZE = 15;
const BLACKLIST_MANAGER_USER_IDS = new Set([
  '872570534519529512',
]);

// Approved / Rejected are reaction-based filters. Discord Search gives us the
// matching messages quickly but not their reactions, so cache the filtered
// record keys briefly to make arrow-button browsing fast and stable.
const STATUS_FILTER_CACHE_TTL_MS = 2 * 60 * 1000;
const statusFilterCache = new Map();

// Keep the user's selected filter independently from component custom IDs.
// This prevents an older button from an All panel from switching the user back
// to All while an Approved/Rejected panel is being rebuilt.
const SEARCH_BROWSE_SESSION_TTL_MS = 15 * 60 * 1000;
const searchBrowseSessions = new Map();

const FILTER_OPTIONS = [
  {
    value: FILTER_ALL,
    label: 'All',
    description: 'Show all media for this ID',
    emoji: '📂',
  },
  {
    value: FILTER_SKINS,
    label: 'Skins',
    description: 'Show skins only',
    emoji: '🖼️',
  },
  {
    value: FILTER_BADGES,
    label: 'Badges',
    description: 'Show badges only',
    emoji: '🏷️',
  },
  {
    value: FILTER_APPROVED,
    label: 'Approved',
    description: 'Show media with an approve reaction',
    emoji: '✔️',
  },
  {
    value: FILTER_REJECTED,
    label: 'Rejected',
    description: 'Show media with a reject reaction',
    emoji: '❌',
  },
];

// Discord's official Search Guild Messages endpoint returns up to 25 matches
// per request. /search uses this instead of walking the entire channel.
const DISCORD_SEARCH_PAGE_SIZE = 25;
const DISCORD_SEARCH_MAX_OFFSET = 9975;

const MEDIA_COLLECTION = 'skin_media_index';
const BLACKLIST_COLLECTION = 'skin_blacklist';
const META_COLLECTION = 'skin_review_meta';

let initializationPromise = null;

function isSourceMediaMessage(message) {
  return Boolean(
    message &&
      String(message.channelId) === SKIN_REVIEW_CHANNEL_ID &&
      String(message.author?.id || '') === SOURCE_MEDIA_BOT_ID,
  );
}

function normalizeMediaId(value) {
  const id = String(value || '').trim().toLowerCase();

  if (!/^[a-f0-9]{24}$/.test(id)) {
    throw new Error('Skin IDs must be a 24-character hexadecimal ID.');
  }

  return id;
}

function cleanMediaUrl(value) {
  return String(value || '')
    .trim()
    .replace(/[>),.;]+$/g, '');
}

function classifyMedia(prefix, url) {
  const normalizedPrefix = String(prefix || '').toLowerCase();

  if (normalizedPrefix === 'clanbadge') {
    return {
      key: 'clanBadge',
      label: 'Clan Badge',
      emoji: '🏷️',
    };
  }

  if (normalizedPrefix === 'clan') {
    return {
      key: 'clan',
      label: 'Clan Skin',
      emoji: '🛡️',
    };
  }

  const lower = String(url || '').toLowerCase();

  if (lower.includes('/vip-skins/')) {
    return {
      key: 'vip',
      label: 'VIP Skin',
      emoji: '💎',
    };
  }

  if (lower.includes('/premium-skins/')) {
    return {
      key: 'premium',
      label: 'Premium Skin',
      emoji: '✨',
    };
  }

  if (lower.includes('/free-skins/')) {
    return {
      key: 'free',
      label: 'Free Skin',
      emoji: '🖼️',
    };
  }

  return {
    key: 'skin',
    label: 'Skin',
    emoji: '🖼️',
  };
}

function parseMediaEntries(content) {
  const source = String(content || '');
  const entries = [];

  // Exact formats supported:
  //
  // clan:<CLAN_ID>|<MEDIA_URL>
  // clanBadge:<CLAN_ID>|<MEDIA_URL>
  // <USER_ID>|<MEDIA_URL>
  //
  // The 24-character value immediately before "|" is always the searchable
  // ID. Everything immediately after "|" up to whitespace / Discord markup is
  // the media URL displayed in /search.
  //
  // The pattern is intentionally not line-anchored, so it still works if the
  // other bot adds text before/after the media record or includes multiple
  // records in a single Discord message.
  const pattern =
    /(?:(clanBadge|clan)\s*:\s*)?([a-fA-F0-9]{24})\s*\|\s*(https?:\/\/[^\s<>\n]+)/gi;

  for (const match of source.matchAll(pattern)) {
    const prefix = match[1] || null;
    const mediaId = String(match[2]).toLowerCase();
    const url = cleanMediaUrl(match[3]);

    if (!url) continue;

    const type = classifyMedia(prefix, url);

    entries.push({
      mediaId,
      prefix,
      url,
      typeKey: type.key,
      typeLabel: type.label,
      typeEmoji: type.emoji,
      raw: match[0].trim(),
    });
  }

  return entries;
}

async function collections() {
  const db = await getMongoDb();

  return {
    media: db.collection(MEDIA_COLLECTION),
    blacklist: db.collection(BLACKLIST_COLLECTION),
    meta: db.collection(META_COLLECTION),
  };
}

async function ensureIndexes() {
  const { media, blacklist } = await collections();

  // Older versions indexed any valid ID|URL record in the source channel.
  // Purge those historical rows so only media posted by the designated source
  // bot can ever appear in /search.
  const cleanup = await media.deleteMany({
    authorId: { $ne: SOURCE_MEDIA_BOT_ID },
  });

  if (cleanup.deletedCount) {
    console.log(
      `[SKIN REVIEW] Removed ${cleanup.deletedCount} indexed media record(s) ` +
        `that were not posted by source bot ${SOURCE_MEDIA_BOT_ID}.`,
    );
  }

  await Promise.all([
    media.createIndex({ mediaId: 1, createdAt: -1 }),
    media.createIndex({ messageId: 1 }),
    media.createIndex({ channelId: 1, mediaId: 1 }),
    blacklist.createIndex({ blacklistedAt: -1 }),
  ]);
}

function compareSnowflakes(left, right) {
  const a = BigInt(String(left));
  const b = BigInt(String(right));

  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

async function indexMediaMessage(message) {
  if (!isSourceMediaMessage(message)) {
    return [];
  }

  const entries = parseMediaEntries(message.content);
  const { media } = await collections();

  await media.deleteMany({
    messageId: String(message.id),
  });

  if (!entries.length) return [];

  const createdAt =
    message.createdAt instanceof Date
      ? message.createdAt
      : new Date(message.createdTimestamp || Date.now());

  const documents = entries.map((entry, index) => ({
    _id: `${message.id}:${index}`,
    guildId: String(message.guildId || message.guild?.id || ''),
    channelId: SKIN_REVIEW_CHANNEL_ID,
    messageId: String(message.id),
    entryIndex: index,
    authorId: String(message.author?.id || ''),
    authorBot: Boolean(message.author?.bot),
    mediaId: entry.mediaId,
    prefix: entry.prefix,
    typeKey: entry.typeKey,
    typeLabel: entry.typeLabel,
    typeEmoji: entry.typeEmoji,
    url: entry.url,
    raw: entry.raw,
    createdAt,
    indexedAt: new Date(),
  }));

  if (documents.length) {
    await media.bulkWrite(
      documents.map((document) => ({
        replaceOne: {
          filter: { _id: document._id },
          replacement: document,
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  return documents;
}

async function updateMetaFromMessages(messages, updates = {}) {
  if (!messages.length) return;

  const ids = messages
    .map((message) => String(message.id))
    .sort(compareSnowflakes);

  const { meta } = await collections();
  const current = await meta.findOne({
    _id: SKIN_REVIEW_CHANNEL_ID,
  });

  const oldest = ids[0];
  const newest = ids[ids.length - 1];

  let oldestIndexedMessageId =
    current?.oldestIndexedMessageId || oldest;
  let newestIndexedMessageId =
    current?.newestIndexedMessageId || newest;

  if (compareSnowflakes(oldest, oldestIndexedMessageId) < 0) {
    oldestIndexedMessageId = oldest;
  }

  if (compareSnowflakes(newest, newestIndexedMessageId) > 0) {
    newestIndexedMessageId = newest;
  }

  await meta.updateOne(
    { _id: SKIN_REVIEW_CHANNEL_ID },
    {
      $set: {
        oldestIndexedMessageId,
        newestIndexedMessageId,
        updatedAt: new Date(),
        ...updates,
      },
    },
    { upsert: true },
  );
}

async function indexBatch(messages) {
  const sorted = [...messages].sort((a, b) =>
    compareSnowflakes(a.id, b.id),
  );

  for (const message of sorted) {
    const documents = await indexMediaMessage(message);

    if (documents.length) {
      await enforceBlacklistOnMessage(
        message,
        documents.map((document) => document.mediaId),
      );
    }
  }

  await updateMetaFromMessages(sorted);

  return sorted;
}

async function syncRecentMessages(channel) {
  const { meta } = await collections();
  const state = await meta.findOne({
    _id: SKIN_REVIEW_CHANNEL_ID,
  });

  if (!state?.newestIndexedMessageId) return;

  let after = String(state.newestIndexedMessageId);

  while (true) {
    const batch = await channel.messages.fetch({
      after,
      limit: 100,
      cache: false,
    });

    if (!batch.size) break;

    const sorted = await indexBatch([...batch.values()]);
    after = String(sorted[sorted.length - 1].id);

    if (batch.size < 100) break;
  }
}

async function backfillHistory(channel) {
  const { meta } = await collections();
  let state = await meta.findOne({
    _id: SKIN_REVIEW_CHANNEL_ID,
  });

  if (state?.backfillComplete) return;

  let before = state?.oldestIndexedMessageId || null;

  while (true) {
    const options = {
      limit: 100,
      cache: false,
    };

    if (before) options.before = before;

    const batch = await channel.messages.fetch(options);

    if (!batch.size) {
      await meta.updateOne(
        { _id: SKIN_REVIEW_CHANNEL_ID },
        {
          $set: {
            backfillComplete: true,
            backfillCompletedAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      break;
    }

    const sorted = await indexBatch([...batch.values()]);
    before = String(sorted[0].id);

    await meta.updateOne(
      { _id: SKIN_REVIEW_CHANNEL_ID },
      {
        $set: {
          oldestIndexedMessageId: before,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

    if (batch.size < 100) {
      await meta.updateOne(
        { _id: SKIN_REVIEW_CHANNEL_ID },
        {
          $set: {
            backfillComplete: true,
            backfillCompletedAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      break;
    }
  }
}

async function getReviewChannel(client) {
  const channel =
    client.channels.cache.get(SKIN_REVIEW_CHANNEL_ID) ||
    (await client.channels.fetch(SKIN_REVIEW_CHANNEL_ID).catch(() => null));

  if (
    !channel ||
    !channel.isTextBased() ||
    !channel.messages?.fetch
  ) {
    throw new Error(
      `Skin review channel ${SKIN_REVIEW_CHANNEL_ID} is missing or not readable.`,
    );
  }

  return channel;
}

async function reconcileBlacklistedMediaOnStartup(client) {
  const {
    blacklist,
    media,
  } = await collections();

  const blacklistedRecords =
    await blacklist
      .find({})
      .project({ _id: 1 })
      .toArray();

  const blacklistedIds =
    blacklistedRecords
      .map((record) =>
        String(record._id || '').toLowerCase(),
      )
      .filter(Boolean);

  if (!blacklistedIds.length) {
    console.log(
      '[SKIN REVIEW] Startup blacklist reconciliation: no blacklisted IDs.',
    );
    return {
      blacklistedIds: 0,
      messagesChecked: 0,
      messagesUpdated: 0,
      missingMessages: 0,
    };
  }

  const indexedRecords =
    await media
      .find({
        mediaId: {
          $in: blacklistedIds,
        },
        channelId:
          SKIN_REVIEW_CHANNEL_ID,
        authorId:
          SOURCE_MEDIA_BOT_ID,
      })
      .project({
        messageId: 1,
        mediaId: 1,
      })
      .toArray();

  const messageIds =
    [
      ...new Set(
        indexedRecords.map((record) =>
          String(record.messageId),
        ),
      ),
    ];

  let messagesChecked = 0;
  let messagesUpdated = 0;
  let missingMessages = 0;

  console.log(
    `[SKIN REVIEW] Startup blacklist reconciliation: ` +
      `${blacklistedIds.length} blacklisted ID(s), ` +
      `${messageIds.length} indexed source message(s) to check.`,
  );

  for (const messageId of messageIds) {
    const message =
      await fetchSourceMessage(
        client,
        messageId,
      );

    if (!message) {
      missingMessages += 1;

      // Keep the index safe and tidy if the original Discord message is gone.
      await media.deleteMany({
        messageId,
        channelId:
          SKIN_REVIEW_CHANNEL_ID,
        authorId:
          SOURCE_MEDIA_BOT_ID,
      });

      continue;
    }

    messagesChecked += 1;

    const ids =
      await getMediaIdsForMessage(
        message,
      );

    const hasBlacklistedId =
      ids.some((id) =>
        blacklistedIds.includes(
          String(id).toLowerCase(),
        ),
      );

    if (!hasBlacklistedId) {
      continue;
    }

    // Blacklisted media keeps the source bot's original approve reaction,
    // while every approve/check reaction from other users is removed.
    // The bot then ensures ❌ is present.
    await rejectBlacklistedMessage(
      message,
    );

    messagesUpdated += 1;

    // Small delay keeps the startup sweep from hammering Discord's reaction
    // endpoints if a blacklisted clan/user has lots of historical media.
    await new Promise((resolve) =>
      setTimeout(resolve, 250),
    );
  }

  console.log(
    `[SKIN REVIEW] Startup blacklist reconciliation complete: ` +
      `${messagesChecked} checked, ` +
      `${messagesUpdated} enforced, ` +
      `${missingMessages} missing/cleaned.`,
  );

  return {
    blacklistedIds:
      blacklistedIds.length,
    messagesChecked,
    messagesUpdated,
    missingMessages,
  };
}

async function initializeSkinReview(client) {
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    await ensureIndexes();

    const channel = await getReviewChannel(client);

    console.log('[SKIN REVIEW] Synchronising media index...');
    await syncRecentMessages(channel);
    await backfillHistory(channel);

    console.log('[SKIN REVIEW] Reconciling blacklisted media...');
    await reconcileBlacklistedMediaOnStartup(client);

    console.log('[SKIN REVIEW] Media index ready.');
  })().catch((error) => {
    initializationPromise = null;
    console.error('[SKIN REVIEW INITIALIZE ERROR]', error);
    throw error;
  });

  return initializationPromise;
}

function normalizeClanName(value) {
  const name = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');

  if (!name) {
    throw new Error('Enter a clan name, for example KOD.');
  }

  if (name.length > 40) {
    throw new Error('Clan name must be 40 characters or fewer.');
  }

  return name;
}

async function getBlacklistRecord(mediaId) {
  const id = normalizeMediaId(mediaId);
  const { blacklist } = await collections();

  return blacklist.findOne({
    _id: id,
  });
}

async function getBlacklistEntries() {
  const { blacklist } = await collections();

  return blacklist
    .find({})
    .sort({
      blacklistedAt: -1,
      _id: 1,
    })
    .toArray();
}

async function isBlacklisted(mediaId) {
  const id = normalizeMediaId(mediaId);
  const { blacklist } = await collections();

  return Boolean(
    await blacklist.findOne({
      _id: id,
    }),
  );
}

async function getBlacklistedIds(mediaIds) {
  const ids = [...new Set(mediaIds.map(normalizeMediaId))];
  if (!ids.length) return new Set();

  const { blacklist } = await collections();
  const records = await blacklist
    .find({
      _id: { $in: ids },
    })
    .project({ _id: 1 })
    .toArray();

  return new Set(records.map((record) => String(record._id)));
}

function normalizedEmojiName(value) {
  return String(value || '').replace(/\uFE0F/g, '');
}

function isApproveReactionName(value) {
  const name = normalizedEmojiName(value);
  return name === '✔' || name === '✅';
}

function isRejectReactionName(value) {
  return normalizedEmojiName(value) === '❌';
}

async function fetchAllReactionUsers(reaction) {
  const users = new Map();
  let after = null;

  while (true) {
    const page = await reaction.users.fetch({
      limit: 100,
      ...(after ? { after } : {}),
    });

    if (!page.size) break;

    for (const user of page.values()) {
      users.set(user.id, user);
    }

    after = [...page.keys()].sort(compareSnowflakes).at(-1);

    if (page.size < 100) break;
  }

  return [...users.values()];
}

async function removeReactionUsers(reaction, preserveUserIds = new Set()) {
  const users = await fetchAllReactionUsers(reaction);

  for (const user of users) {
    if (preserveUserIds.has(String(user.id))) continue;

    await reaction.users.remove(user.id).catch((error) => {
      console.error(
        `[SKIN REVIEW] Could not remove ${reaction.emoji.name} from ${user.id}:`,
        error,
      );
    });
  }
}

async function fetchSourceMessage(client, messageId) {
  const channel = await getReviewChannel(client);

  const message = await channel.messages
    .fetch(String(messageId))
    .catch(() => null);

  return isSourceMediaMessage(message)
    ? message
    : null;
}

async function rejectMessage(message) {
  if (!message) throw new Error('The source media message no longer exists.');

  for (const reaction of message.reactions.cache.values()) {
    if (!isApproveReactionName(reaction.emoji.name)) continue;

    await removeReactionUsers(
      reaction,
      new Set([PROTECTED_REACTION_BOT_ID]),
    );
  }

  await message.react(REJECT_EMOJI);
}

async function rejectBlacklistedMessage(message) {
  if (!message) {
    throw new Error('The source media message no longer exists.');
  }

  // Keep only the source bot's original approve reaction. Removing users
  // individually avoids deleting the protected bot reaction with the group.
  for (const reaction of message.reactions.cache.values()) {
    if (!isApproveReactionName(reaction.emoji.name)) continue;

    await removeReactionUsers(
      reaction,
      new Set([PROTECTED_REACTION_BOT_ID]),
    );
  }

  // Ensure the blacklist rejection marker is present.
  if (
    ![...message.reactions.cache.values()].some(
      (reaction) =>
        isRejectReactionName(reaction.emoji.name) &&
        reaction.me,
    )
  ) {
    await message.react(REJECT_EMOJI);
  }
}

async function restoreUnblacklistedMessage(
  message,
) {
  if (!message) {
    throw new Error(
      'The source media message no longer exists.',
    );
  }

  // Keep the source media bot's neutral ❌ and remove every other
  // reject vote individually.
  for (
    const reaction of
    message.reactions.cache.values()
  ) {
    if (
      !isRejectReactionName(
        reaction.emoji.name,
      )
    ) {
      continue;
    }

    await removeReactionUsers(
      reaction,
      new Set([PROTECTED_REACTION_BOT_ID]),
    );
  }

  const currentBotId =
    String(
      message.client.user.id,
    );

  let sourceBotApproveReaction =
    null;

  let currentBotIsOnSourceReaction =
    false;

  const strayCurrentBotReactions =
    [];

  for (
    const reaction of
    message.reactions.cache.values()
  ) {
    if (
      !isApproveReactionName(
        reaction.emoji.name,
      )
    ) {
      continue;
    }

    const users =
      await fetchAllReactionUsers(
        reaction,
      );

    const userIds =
      new Set(
        users.map(
          (user) =>
            String(
              user.id,
            ),
        ),
      );

    if (
      userIds.has(
        PROTECTED_REACTION_BOT_ID,
      )
    ) {
      sourceBotApproveReaction =
        reaction;

      currentBotIsOnSourceReaction =
        userIds.has(
          currentBotId,
        );
    } else if (
      userIds.has(
        currentBotId,
      )
    ) {
      strayCurrentBotReactions.push(
        reaction,
      );
    }
  }

  // Repair older unblacklist results that placed our checkmark on a separate
  // Unicode variant instead of the source bot's original reaction group.
  if (sourceBotApproveReaction) {
    for (
      const reaction of
      strayCurrentBotReactions
    ) {
      await reaction.users
        .remove(
          currentBotId,
        )
        .catch((error) => {
          console.error(
            '[SKIN RESTORE STRAY APPROVE REACTION REMOVE ERROR]',
            error,
          );
        });
    }

    if (
      !currentBotIsOnSourceReaction
    ) {
      await message.react(
        sourceBotApproveReaction.emoji,
      );
    }

    return;
  }

  // Legacy fallback for a message where the source bot's approve reaction is
  // genuinely missing.
  const currentBotApproveReaction =
    [
      ...message.reactions.cache.values(),
    ].find(
      (reaction) =>
        isApproveReactionName(
          reaction.emoji.name,
        ) &&
        reaction.me,
    );

  if (!currentBotApproveReaction) {
    await message.react(
      APPROVE_EMOJI,
    );
  }
}


async function approveMessage(message) {
  if (!message) throw new Error('The source media message no longer exists.');

  for (const reaction of message.reactions.cache.values()) {
    if (!isRejectReactionName(reaction.emoji.name)) continue;

    await removeReactionUsers(reaction);
  }

  await message.react(APPROVE_EMOJI);
}

async function enforceBlacklistOnMessage(message, mediaIds = null) {
  if (!isSourceMediaMessage(message)) return false;

  const ids = mediaIds || parseMediaEntries(message.content).map((entry) => entry.mediaId);
  if (!ids.length) return false;

  const blacklisted = await getBlacklistedIds(ids);
  if (!blacklisted.size) return false;

  await rejectBlacklistedMessage(message);
  return true;
}

async function handleSkinReviewMessageCreate(message) {
  if (!isSourceMediaMessage(message)) return;

  const documents = await indexMediaMessage(message);
  if (!documents.length) return;

  await updateMetaFromMessages([message]);

  await enforceBlacklistOnMessage(
    message,
    documents.map((document) => document.mediaId),
  );
}

async function handleSkinReviewMessageUpdate(oldMessage, newMessage) {
  let message = newMessage;

  if (message?.partial) {
    message = await message.fetch().catch(() => null);
  }

  if (!isSourceMediaMessage(message)) return;

  const documents = await indexMediaMessage(message);

  if (documents.length) {
    await enforceBlacklistOnMessage(
      message,
      documents.map((document) => document.mediaId),
    );
  }
}

async function handleSkinReviewMessageDelete(message) {
  if (!message || message.channelId !== SKIN_REVIEW_CHANNEL_ID) return;

  const { media } = await collections();

  await media.deleteMany({
    messageId: String(message.id),
  });
}

async function getMediaIdsForMessage(message) {
  const { media } = await collections();
  let records = await media
    .find({
      messageId: String(message.id),
      authorId: SOURCE_MEDIA_BOT_ID,
    })
    .project({ mediaId: 1 })
    .toArray();

  if (!records.length) {
    records = await indexMediaMessage(message);
  }

  return [...new Set(records.map((record) => String(record.mediaId)))];
}

async function handleSkinReviewReactionAdd(reaction, user) {
  if (!reaction || !user) return;

  if (reaction.partial) {
    reaction = await reaction.fetch().catch(() => null);
  }

  if (!reaction) return;

  let message = reaction.message;

  if (message?.partial) {
    message = await message.fetch().catch(() => null);
  }

  if (!isSourceMediaMessage(message)) return;
  if (!isApproveReactionName(reaction.emoji.name)) return;

  const mediaIds = await getMediaIdsForMessage(message);
  if (!mediaIds.length) return;

  const blacklisted = await getBlacklistedIds(mediaIds);
  if (!blacklisted.size) return;

  // Remove every user's approve reaction while preserving the source
  // media bot's own reaction.
  await removeReactionUsers(
    reaction,
    new Set([PROTECTED_REACTION_BOT_ID]),
  );

  await message.react(REJECT_EMOJI).catch((error) => {
    console.error('[SKIN REVIEW BLACKLIST REJECT REACTION ERROR]', error);
  });
}

async function sendSkinAccessDenied(
  interaction,
  content,
) {
  const payload = {
    content,
    flags:
      MessageFlags.Ephemeral,
    allowedMentions: {
      parse: [],
    },
  };

  if (
    interaction.deferred ||
    interaction.replied
  ) {
    await interaction
      .followUp(payload)
      .catch(() => {});
  } else if (
    interaction.isRepliable()
  ) {
    await interaction
      .reply(payload)
      .catch(() => {});
  }
}

function isSkinBlacklistManager(member) {
  return Boolean(
    member &&
    (
      member.permissions?.has(
        PermissionFlagsBits.Administrator,
      ) ||
      BLACKLIST_MANAGER_USER_IDS.has(
        String(
          member.id ||
          member.user?.id ||
          '',
        ),
      )
    )
  );
}

async function requireSearchAccess(interaction) {
  if (!interaction.inGuild()) {
    await sendSkinAccessDenied(
      interaction,
      'Use the skin review system inside the Snay.io server.',
    );
    return null;
  }

  const member =
    await interaction.guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null);

  if (!member) {
    await sendSkinAccessDenied(
      interaction,
      'I could not resolve your server permissions.',
    );
    return null;
  }

  if (
    !canMemberUseCommandSync(
      member,
      'chat:search',
    )
  ) {
    await sendSkinAccessDenied(
      interaction,
      'You do not have permission to use the skin search/review system.',
    );
    return null;
  }

  const reviewChannel =
    interaction.guild.channels.cache.get(
      SKIN_REVIEW_CHANNEL_ID,
    ) ||
    (await interaction.guild.channels
      .fetch(
        SKIN_REVIEW_CHANNEL_ID,
      )
      .catch(() => null));

  if (
    !reviewChannel ||
    !reviewChannel.isTextBased()
  ) {
    await sendSkinAccessDenied(
      interaction,
      `I could not access the configured skin moderation channel <#${SKIN_REVIEW_CHANNEL_ID}>.`,
    );
    return null;
  }

  const permissions =
    reviewChannel.permissionsFor(
      member,
    );

  if (
    !permissions?.has(
      PermissionFlagsBits.ViewChannel,
    ) ||
    !permissions?.has(
      PermissionFlagsBits.ReadMessageHistory,
    )
  ) {
    await sendSkinAccessDenied(
      interaction,
      `You need access to <#${SKIN_REVIEW_CHANNEL_ID}> to use skin search/review.`,
    );
    return null;
  }

  return member;
}

async function requireBlacklistAdministrator(
  interaction,
  member,
) {
  if (
    isSkinBlacklistManager(
      member,
    )
  ) {
    return true;
  }

  await sendSkinAccessDenied(
    interaction,
    'Only server **Administrators** or authorised blacklist managers can Blacklist or UnBlacklist IDs.',
  );

  return false;
}

async function assertSourceChannelPermissions(client) {
  const channel = await getReviewChannel(client);
  const guild = channel.guild;
  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));

  if (!me) {
    throw new Error('I could not resolve my server member for the skin channel.');
  }

  const permissions = channel.permissionsFor(me);
  const required = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
    [PermissionFlagsBits.AddReactions, 'Add Reactions'],
    [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  ];

  const missing = required
    .filter(([permission]) => !permissions?.has(permission))
    .map(([, name]) => name);

  if (missing.length) {
    throw new Error(
      `I am missing permissions in <#${SKIN_REVIEW_CHANNEL_ID}>: ${missing.join(', ')}.`,
    );
  }

  return channel;
}

function flattenDiscordSearchMessages(response) {
  const groups =
    Array.isArray(response?.messages)
      ? response.messages
      : [];

  const messages = [];

  for (const group of groups) {
    if (Array.isArray(group)) {
      for (const raw of group) {
        if (raw?.id) messages.push(raw);
      }
    } else if (group?.id) {
      messages.push(group);
    }
  }

  return messages;
}

function reactionCountsFromDiscordSearchMessage(
  rawMessage,
) {
  if (
    !Array.isArray(
      rawMessage?.reactions,
    )
  ) {
    return null;
  }

  let approve = 0;
  let reject = 0;

  for (
    const reaction of
    rawMessage.reactions
  ) {
    const name =
      reaction?.emoji?.name;

    const count =
      Number(
        reaction?.count,
      ) || 0;

    if (
      isApproveReactionName(
        name,
      )
    ) {
      approve += count;
    } else if (
      isRejectReactionName(
        name,
      )
    ) {
      reject += count;
    }
  }

  return {
    approve,
    reject,
  };
}

async function searchDiscordMediaById(
  client,
  mediaId,
  {
    offset = 0,
    limit = DISCORD_SEARCH_PAGE_SIZE,
  } = {},
) {
  const id = normalizeMediaId(mediaId);
  const channel = await getReviewChannel(client);
  const guildId = String(channel.guildId || channel.guild?.id || '');

  if (!guildId) {
    throw new Error(
      'Could not determine the guild for the skin review channel.',
    );
  }

  const query = new URLSearchParams();

  // Search the exact 24-character ID in message content, while hard-locking
  // results to the designated source channel and designated source bot.
  query.append('content', id);
  query.append('channel_id', SKIN_REVIEW_CHANNEL_ID);
  query.append('author_id', SOURCE_MEDIA_BOT_ID);
  query.append(
    'limit',
    String(
      Math.min(
        Math.max(Number(limit) || 1, 1),
        DISCORD_SEARCH_PAGE_SIZE,
      ),
    ),
  );
  query.append(
    'offset',
    String(
      Math.min(
        Math.max(Number(offset) || 0, 0),
        DISCORD_SEARCH_MAX_OFFSET,
      ),
    ),
  );
  query.append('sort_by', 'timestamp');
  query.append('sort_order', 'desc');

  let response;

  try {
    response = await client.rest.get(
      Routes.guildMessagesSearch(guildId),
      {
        query,
      },
    );
  } catch (error) {
    // Discord can answer 202/110000 while a guild search index is still being
    // prepared. Keep this explicit so /search can use Mongo/cache fallback.
    const rawCode =
      error?.rawError?.code ??
      error?.code ??
      null;

    if (
      Number(rawCode) === 110000 ||
      Number(error?.status) === 202
    ) {
      const retryAfter =
        Number(
          error?.rawError?.retry_after ??
          error?.retry_after ??
          0,
        ) || 0;

      const indexingError = new Error(
        'Discord search index is still being prepared.',
      );

      indexingError.discordSearchIndexing = true;
      indexingError.retryAfter = retryAfter;
      throw indexingError;
    }

    throw error;
  }

  const rawMessages =
    flattenDiscordSearchMessages(response);

  const parsedRecords = [];

  for (const raw of rawMessages) {
    if (
      String(raw.channel_id || '') !== SKIN_REVIEW_CHANNEL_ID ||
      String(raw.author?.id || '') !== SOURCE_MEDIA_BOT_ID
    ) {
      continue;
    }

    const entries =
      parseMediaEntries(raw.content);

    const searchReactionCounts =
      reactionCountsFromDiscordSearchMessage(
        raw,
      );

    for (
      let entryIndex = 0;
      entryIndex < entries.length;
      entryIndex += 1
    ) {
      const entry = entries[entryIndex];

      if (entry.mediaId !== id) continue;

      parsedRecords.push({
        _id: `${raw.id}:${entryIndex}`,
        guildId,
        channelId:
          SKIN_REVIEW_CHANNEL_ID,
        messageId:
          String(raw.id),
        entryIndex,
        authorId:
          SOURCE_MEDIA_BOT_ID,
        authorBot:
          true,
        mediaId:
          entry.mediaId,
        prefix:
          entry.prefix,
        typeKey:
          entry.typeKey,
        typeLabel:
          entry.typeLabel,
        typeEmoji:
          entry.typeEmoji,
        url:
          entry.url,
        raw:
          entry.raw,
        createdAt:
          raw.timestamp
            ? new Date(raw.timestamp)
            : new Date(),
        indexedAt:
          new Date(),
        source:
          'discord_search',
        _searchReactionCounts:
          searchReactionCounts,
        _searchReactionSnapshotAt:
          searchReactionCounts
            ? Date.now()
            : null,
      });
    }
  }

  // Discord Search commonly includes the message reaction summary. Preserve
  // it when available so Approved/Rejected filtering can be instant. Individual
  // Get Channel Message calls remain the fallback when reaction data is absent.
  // Upsert the record so blacklist/startup reconciliation still has an index.
  if (parsedRecords.length) {
    const { media } =
      await collections();

    await media.bulkWrite(
      parsedRecords.map(
        (record) => ({
          replaceOne: {
            filter: {
              _id:
                record._id,
            },
            replacement:
              record,
            upsert:
              true,
          },
        }),
      ),
      {
        ordered:
          false,
      },
    );
  }

  return {
    records:
      parsedRecords,
    totalResults:
      Number(
        response?.total_results,
      ) || parsedRecords.length,
    offset:
      Number(offset) || 0,
    rawResultCount:
      rawMessages.length,
    doingDeepHistoricalIndex:
      Boolean(
        response?.doing_deep_historical_index,
      ),
  };
}

async function getRecordsFromMongo(mediaId) {
  const id = normalizeMediaId(mediaId);
  const { media } = await collections();

  return media
    .find({
      mediaId: id,
      channelId: SKIN_REVIEW_CHANNEL_ID,
      authorId: SOURCE_MEDIA_BOT_ID,
    })
    .sort({
      createdAt: -1,
      messageId: -1,
      entryIndex: 1,
    })
    .toArray();
}

async function getRecordsUsingDiscordSearch(
  client,
  mediaId,
) {
  const id = normalizeMediaId(mediaId);
  const searchStartedAt = Date.now();
  const all = [];
  const seenKeys = new Set();
  let offset = 0;
  let reportedTotal = null;

  while (
    offset <=
    DISCORD_SEARCH_MAX_OFFSET
  ) {
    const result =
      await searchDiscordMediaById(
        client,
        id,
        {
          offset,
          limit:
            DISCORD_SEARCH_PAGE_SIZE,
        },
      );

    if (reportedTotal === null) {
      reportedTotal =
        result.totalResults;
    }

    for (
      const record of result.records
    ) {
      const key =
        `${record.messageId}:${record.entryIndex}`;

      if (
        seenKeys.has(key)
      ) {
        continue;
      }

      seenKeys.add(key);
      all.push(record);
    }

    // Discord explicitly warns that result page length should not be used as
    // the only pagination signal. Use total_results + 25-result offsets.
    offset +=
      DISCORD_SEARCH_PAGE_SIZE;

    if (
      reportedTotal !== null &&
      offset >= reportedTotal
    ) {
      break;
    }

    if (
      !result.rawResultCount
    ) {
      break;
    }
  }

  all.sort(
    (a, b) => {
      const dateDifference =
        new Date(b.createdAt).getTime() -
        new Date(a.createdAt).getTime();

      if (dateDifference) {
        return dateDifference;
      }

      return compareSnowflakes(
        b.messageId,
        a.messageId,
      );
    },
  );

  console.log(
    `[SKIN SEARCH] Discord search for ${id} returned ${all.length} media item(s) ` +
      `in ${Date.now() - searchStartedAt}ms.`,
  );

  return all;
}

async function getRecords(mediaId) {
  return getRecordsFromMongo(mediaId);
}

function recordKey(record) {
  return `${record.messageId}.${record.entryIndex}`;
}

function parseRecordKey(value) {
  const match = String(value || '').match(/^(\d{16,22})\.(\d{1,3})$/);
  if (!match) return null;

  return {
    messageId: match[1],
    entryIndex: Number(match[2]),
  };
}

async function getRecordByKey(mediaId, key) {
  const parsed = parseRecordKey(key);
  if (!parsed) return null;

  const { media } = await collections();

  return media.findOne({
    mediaId: normalizeMediaId(mediaId),
    channelId: SKIN_REVIEW_CHANNEL_ID,
    authorId: SOURCE_MEDIA_BOT_ID,
    messageId: parsed.messageId,
    entryIndex: parsed.entryIndex,
  });
}

function reactionCounts(message) {
  let approve = 0;
  let reject = 0;

  if (!message) return { approve, reject };

  for (const reaction of message.reactions.cache.values()) {
    if (isApproveReactionName(reaction.emoji.name)) {
      approve += Number(reaction.count) || 0;
    } else if (isRejectReactionName(reaction.emoji.name)) {
      reject += Number(reaction.count) || 0;
    }
  }

  return { approve, reject };
}

function reactionStatusFromCounts(counts) {
  const approve =
    Number(counts?.approve) || 0;

  const reject =
    Number(counts?.reject) || 0;

  // The source bot starts media at a neutral 1:1 reaction state.
  // Treat equal approve/reject totals as Pending. Staff moderation then tips
  // the result toward Approved or Rejected.
  if (approve > reject) {
    return {
      key: FILTER_APPROVED,
      label: 'Approved',
    };
  }

  if (reject > approve) {
    return {
      key: FILTER_REJECTED,
      label: 'Rejected',
    };
  }

  return {
    key: 'pending',
    label: 'Pending',
  };
}

async function hydrateRecordsForStatusFilter(
  client,
  records,
  concurrency = 8,
) {
  const hydrated = new Array(
    records.length,
  );

  let cursor = 0;

  async function worker() {
    while (true) {
      const index =
        cursor;

      cursor += 1;

      if (
        index >= records.length
      ) {
        return;
      }

      const record =
        records[index];

      const searchCounts =
        record?._searchReactionCounts;

      // Fast path: use the reaction totals that arrived with Discord Search.
      // This avoids dozens of per-message REST fetches just to choose a filter.
      if (
        searchCounts &&
        Number.isFinite(
          Number(
            searchCounts.approve,
          ),
        ) &&
        Number.isFinite(
          Number(
            searchCounts.reject,
          ),
        )
      ) {
        const counts = {
          approve:
            Number(
              searchCounts.approve,
            ) || 0,
          reject:
            Number(
              searchCounts.reject,
            ) || 0,
        };

        const status =
          reactionStatusFromCounts(
            counts,
          );

        hydrated[index] = {
          ...record,
          _reactionCounts:
            counts,
          _reactionStatus:
            status.key,
          _reactionStatusLabel:
            status.label,
        };

        continue;
      }

      // Fallback for Discord responses that omit reactions.
      const message =
        await fetchSourceMessage(
          client,
          record.messageId,
        );

      if (!message) {
        hydrated[index] = null;
        continue;
      }

      const counts =
        reactionCounts(
          message,
        );

      const status =
        reactionStatusFromCounts(
          counts,
        );

      hydrated[index] = {
        ...record,
        _message:
          message,
        _reactionCounts:
          counts,
        _reactionStatus:
          status.key,
        _reactionStatusLabel:
          status.label,
      };
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            Math.max(
              records.length,
              1,
            ),
            concurrency,
          ),
      },
      () => worker(),
    ),
  );

  return hydrated.filter(Boolean);
}

function normalizeSearchFilter(value) {
  const filter = String(value || FILTER_ALL).toLowerCase();

  if (
    filter !== FILTER_ALL &&
    filter !== FILTER_SKINS &&
    filter !== FILTER_BADGES &&
    filter !== FILTER_APPROVED &&
    filter !== FILTER_REJECTED
  ) {
    return FILTER_ALL;
  }

  return filter;
}

function filterLabel(value) {
  const filter = normalizeSearchFilter(value);
  return (
    FILTER_OPTIONS.find((option) => option.value === filter)?.label ||
    'All'
  );
}

function isStatusFilter(value) {
  const filter =
    normalizeSearchFilter(
      value,
    );

  return (
    filter === FILTER_APPROVED ||
    filter === FILTER_REJECTED
  );
}

function browseSessionKey(
  interaction,
  mediaId,
) {
  return [
    String(
      interaction.guildId ||
      interaction.guild?.id ||
      'dm',
    ),
    String(
      interaction.user?.id ||
      'unknown',
    ),
    normalizeMediaId(
      mediaId,
    ),
  ].join(':');
}

function setBrowseSessionFilter(
  interaction,
  mediaId,
  filterValue,
) {
  const key =
    browseSessionKey(
      interaction,
      mediaId,
    );

  searchBrowseSessions.set(
    key,
    {
      filter:
        normalizeSearchFilter(
          filterValue,
        ),
      touchedAt:
        Date.now(),
    },
  );
}

function getBrowseSessionFilter(
  interaction,
  mediaId,
) {
  const key =
    browseSessionKey(
      interaction,
      mediaId,
    );

  const session =
    searchBrowseSessions.get(
      key,
    );

  if (!session) {
    return null;
  }

  if (
    Date.now() -
      session.touchedAt >
    SEARCH_BROWSE_SESSION_TTL_MS
  ) {
    searchBrowseSessions.delete(
      key,
    );

    return null;
  }

  session.touchedAt =
    Date.now();

  return normalizeSearchFilter(
    session.filter,
  );
}

function resolveBrowseFilter(
  interaction,
  mediaId,
  customIdFilter,
) {
  return (
    getBrowseSessionFilter(
      interaction,
      mediaId,
    ) ||
    normalizeSearchFilter(
      customIdFilter,
    )
  );
}

function statusFilterCacheKey(
  mediaId,
  filterValue,
) {
  return (
    `${normalizeMediaId(mediaId)}:` +
    `${normalizeSearchFilter(filterValue)}`
  );
}

function getCachedStatusFilter(
  mediaId,
  filterValue,
) {
  if (
    !isStatusFilter(
      filterValue,
    )
  ) {
    return null;
  }

  const key =
    statusFilterCacheKey(
      mediaId,
      filterValue,
    );

  const cached =
    statusFilterCache.get(
      key,
    );

  if (!cached) {
    return null;
  }

  if (
    Date.now() -
      cached.createdAt >
    STATUS_FILTER_CACHE_TTL_MS
  ) {
    statusFilterCache.delete(
      key,
    );

    return null;
  }

  return cached;
}

function setCachedStatusFilter(
  mediaId,
  filterValue,
  records,
) {
  if (
    !isStatusFilter(
      filterValue,
    )
  ) {
    return;
  }

  const key =
    statusFilterCacheKey(
      mediaId,
      filterValue,
    );

  statusFilterCache.set(
    key,
    {
      createdAt:
        Date.now(),
      records:
        records.map(
          (record) => ({
            recordKey:
              recordKey(
                record,
              ),
            reactionStatus:
              record._reactionStatus ||
              null,
            reactionStatusLabel:
              record._reactionStatusLabel ||
              null,
          }),
        ),
    },
  );
}

function invalidateStatusFilterCache(
  mediaId,
) {
  const id =
    normalizeMediaId(
      mediaId,
    );

  statusFilterCache.delete(
    statusFilterCacheKey(
      id,
      FILTER_APPROVED,
    ),
  );

  statusFilterCache.delete(
    statusFilterCacheKey(
      id,
      FILTER_REJECTED,
    ),
  );
}

function applyCachedStatusFilter(
  records,
  cached,
  filterValue,
) {
  if (
    !cached?.records?.length
  ) {
    return [];
  }

  const sourceByKey =
    new Map(
      records.map(
        (record) => [
          recordKey(
            record,
          ),
          record,
        ],
      ),
    );

  const expectedFilter =
    normalizeSearchFilter(
      filterValue,
    );

  const filtered = [];

  for (
    const cachedRecord of
    cached.records
  ) {
    const source =
      sourceByKey.get(
        cachedRecord.recordKey,
      );

    if (!source) continue;

    filtered.push({
      ...source,
      _reactionStatus:
        cachedRecord.reactionStatus ||
        expectedFilter,
      _reactionStatusLabel:
        cachedRecord.reactionStatusLabel ||
        filterLabel(
          expectedFilter,
        ),
    });
  }

  return filtered;
}

function recordMatchesFilter(record, filterValue) {
  const filter =
    normalizeSearchFilter(
      filterValue,
    );

  const typeKey =
    String(
      record?.typeKey || '',
    ).toLowerCase();

  if (filter === FILTER_ALL) {
    return true;
  }

  if (filter === FILTER_BADGES) {
    return (
      typeKey === 'clanbadge' ||
      typeKey === 'badge'
    );
  }

  if (filter === FILTER_SKINS) {
    return !(
      typeKey === 'clanbadge' ||
      typeKey === 'badge'
    );
  }

  if (filter === FILTER_APPROVED) {
    return (
      record?._reactionStatus ===
      FILTER_APPROVED
    );
  }

  if (filter === FILTER_REJECTED) {
    return (
      record?._reactionStatus ===
      FILTER_REJECTED
    );
  }

  return true;
}

async function hydratePageRecords(client, records) {
  return Promise.all(
    records.map(
      async (record) => {
        const message =
          record._message ||
          (await fetchSourceMessage(
            client,
            record.messageId,
          ));

        const counts =
          record._reactionCounts ||
          reactionCounts(
            message,
          );

        const status =
          record._reactionStatus
            ? {
                key:
                  record._reactionStatus,
                label:
                  record._reactionStatusLabel ||
                  (
                    record._reactionStatus ===
                    FILTER_APPROVED
                      ? 'Approved'
                      : record._reactionStatus ===
                          FILTER_REJECTED
                        ? 'Rejected'
                        : 'Pending'
                  ),
              }
            : reactionStatusFromCounts(
                counts,
              );

        return {
          record,
          message,
          counts,
          status,
        };
      },
    ),
  );
}

function searchCustomId(action, mediaId, page, filterValue = FILTER_ALL, extra = null) {
  return [
    'skinreview',
    action,
    mediaId,
    String(page),
    normalizeSearchFilter(filterValue),
    ...(extra ? [extra] : []),
  ].join(':');
}

function assertUniqueComponentCustomIds(components) {
  const seen = new Set();

  for (const row of components || []) {
    const json =
      typeof row?.toJSON === 'function'
        ? row.toJSON()
        : row;

    for (const component of json?.components || []) {
      const customId =
        component?.custom_id ||
        component?.customId ||
        null;

      if (!customId) continue;

      if (seen.has(customId)) {
        throw new Error(
          `Duplicate Discord component custom_id generated: ${customId}`,
        );
      }

      seen.add(customId);
    }
  }
}

async function buildSearchPanel(
  client,
  mediaId,
  requestedPage = 0,
  selectedKey = null,
  requestedFilter = FILTER_ALL,
  canManageBlacklist = false,
) {
  const id = normalizeMediaId(mediaId);
  const panelStartedAt = Date.now();
  const activeFilter = normalizeSearchFilter(requestedFilter);
  let records = [];
  let searchSource = 'Discord Search';

  try {
    records = await getRecordsUsingDiscordSearch(
      client,
      id,
    );
  } catch (error) {
    console.error(
      '[SKIN REVIEW DISCORD SEARCH ERROR]',
      error,
    );

    // Discord can temporarily return 202 while its search index is preparing,
    // or REST search may be unavailable due to an API/indexing issue. The
    // existing Mongo index remains a safe fallback rather than making /search
    // unusable.
    records = await getRecordsFromMongo(id);
    searchSource =
      error?.discordSearchIndexing
        ? 'MongoDB cache (Discord indexing)'
        : 'MongoDB cache (Discord search fallback)';
  }

  const blacklistRecord =
    await getBlacklistRecord(id);

  const blacklisted =
    Boolean(blacklistRecord);

  const blacklistName =
    blacklistRecord
      ? String(
          blacklistRecord.clanName ||
            blacklistRecord.name ||
            'Unnamed',
        )
      : null;

  const allRecordCount =
    records.length;

  if (
    isStatusFilter(
      activeFilter,
    )
  ) {
    const cached =
      getCachedStatusFilter(
        id,
        activeFilter,
      );

    if (cached) {
      records =
        applyCachedStatusFilter(
          records,
          cached,
          activeFilter,
        );

      console.log(
        `[SKIN SEARCH] Reused ${filterLabel(activeFilter)} browser snapshot ` +
          `for ${id} with ${records.length} matching media item(s).`,
      );
    } else {
      const statusStartedAt =
        Date.now();

      const hydratedRecords =
        await hydrateRecordsForStatusFilter(
          client,
          records,
        );

      records =
        hydratedRecords.filter(
          (record) =>
            recordMatchesFilter(
              record,
              activeFilter,
            ),
        );

      setCachedStatusFilter(
        id,
        activeFilter,
        records,
      );

      console.log(
        `[SKIN SEARCH] Built ${filterLabel(activeFilter)} browser snapshot ` +
          `for ${id}: ${records.length}/${allRecordCount} matching item(s) ` +
          `in ${Date.now() - statusStartedAt}ms.`,
      );
    }
  } else {
    records =
      records.filter(
        (record) =>
          recordMatchesFilter(
            record,
            activeFilter,
          ),
      );
  }

  if (!allRecordCount) {
    return {
      empty: true,
      payload: {
        content:
          `🔎 I could not find any media associated with \`${id}\` in <#${SKIN_REVIEW_CHANNEL_ID}>.`,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      },
    };
  }

  if (!records.length) {
    return {
      empty: true,
      payload: {
        content:
          `🔎 I found media for \`${id}\`, but none matched the **${filterLabel(activeFilter)}** filter.`,
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(
              `🔎 Skin / Badge Search • ${filterLabel(activeFilter)}`,
            )
            .setDescription(
              `**ID:** \`${id}\`\n` +
                `**Active Filter:** ${FILTER_OPTIONS.find((option) => option.value === activeFilter)?.emoji || '🔎'} **${filterLabel(activeFilter)}**\n` +
                `**Results:** 0 matching / ${allRecordCount} total\n` +
                `**Source:** ${searchSource}\n` +
                `**Blacklist:** ${
                  blacklisted
                    ? `🚫 **${blacklistName}** | \`${id}\``
                    : '✅ Not blacklisted'
                }`,
            ),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(searchCustomId('filter', id, 0, activeFilter))
              .setPlaceholder(
      `Filtering: ${filterLabel(activeFilter)}`,
    )
              .setMinValues(1)
              .setMaxValues(1)
              .addOptions(
                FILTER_OPTIONS.map((option) =>
                  new StringSelectMenuOptionBuilder()
                    .setLabel(option.label)
                    .setDescription(option.description)
                    .setEmoji(option.emoji)
                    .setValue(option.value)
                    .setDefault(option.value === activeFilter),
                ),
              ),
          ),
        ],
        allowedMentions: { parse: [] },
      },
    };
  }

  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const page = Math.min(Math.max(Number(requestedPage) || 0, 0), pageCount - 1);
  const pageRecords = records.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const hydrated = await hydratePageRecords(client, pageRecords);

  const activeFilterOption =
    FILTER_OPTIONS.find(
      (option) =>
        option.value ===
        activeFilter,
    );

  const activeFilterEmoji =
    activeFilterOption?.emoji ||
    '🔎';

  const header = new EmbedBuilder()
    .setColor(blacklisted ? 0xed4245 : 0x5865f2)
    .setTitle(
      `🔎 Skin / Badge Search • ${filterLabel(activeFilter)}`,
    )
    .setDescription(
      `**ID:** \`${id}\`\n` +
        `**Active Filter:** ${activeFilterEmoji} **${filterLabel(activeFilter)}**\n` +
        `**Results:** ${records.length} matching / ${allRecordCount} total\n` +
        `**Page:** ${page + 1}/${pageCount}\n` +
        `**Source:** ${searchSource}\n` +
        `**Blacklist:** ${
          blacklisted
            ? `🚫 **${blacklistName}** | \`${id}\``
            : '✅ Not blacklisted'
        }` +
        (selectedKey ? `\n**Selected:** \`${selectedKey}\`` : ''),
    )
    .setFooter({
      text:
        canManageBlacklist
          ? (
              isStatusFilter(activeFilter)
                ? `${filterLabel(activeFilter)} browser • arrows stay inside this filter • Restore repairs all associated media`
                : 'Approve/Reject selected media • Restore repairs all associated media for this ID'
            )
          : (
              isStatusFilter(activeFilter)
                ? `${filterLabel(activeFilter)} browser • arrows stay inside this filter`
                : 'Select a media item, choose a filter if needed, then Approve or Reject it.'
            ),
    });

  const embeds = [header];

  hydrated.forEach(({ record, message, counts, status }, index) => {
    const absoluteIndex = page * PAGE_SIZE + index + 1;
    const key = recordKey(record);
    const selected = key === selectedKey;

    const embed = new EmbedBuilder()
      .setColor(selected ? 0xfee75c : 0x2b2d31)
      .setTitle(
        `${selected ? '▶ ' : ''}${absoluteIndex}. ${record.typeEmoji || '🖼️'} ${record.typeLabel || 'Skin'}`,
      )
      .setDescription(
        `**ID:** \`${record.mediaId}\`\n` +
          `**Message:** ${message ? `[Jump to source](${message.url})` : '⚠️ Source message unavailable'}\n` +
          `**Reactions:** ${APPROVE_EMOJI} ${counts.approve} • ${REJECT_EMOJI} ${counts.reject} • **Status:** ${status.label}\n` +
          `**Source message ID:** \`${record.messageId}\``,
      )
      .setImage(record.url)
      .setTimestamp(new Date(record.createdAt));

    embeds.push(embed);
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(
      searchCustomId(
        'select',
        id,
        page,
        activeFilter,
      ),
    )
    .setPlaceholder('Select a skin / badge on this page')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      pageRecords.map((record, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(
            `${page * PAGE_SIZE + index + 1}. ${record.typeLabel || 'Skin'}`.slice(0, 100),
          )
          .setDescription(
            `${record.mediaId} • ${record.messageId}`.slice(0, 100),
          )
          .setValue(recordKey(record))
          .setDefault(recordKey(record) === selectedKey),
      ),
    );

  const filterMenu = new StringSelectMenuBuilder()
    .setCustomId(searchCustomId('filter', id, page, activeFilter))
    .setPlaceholder(
      `Filtering: ${filterLabel(activeFilter)}`,
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      FILTER_OPTIONS.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setDescription(option.description)
          .setEmoji(option.emoji)
          .setValue(option.value)
          .setDefault(option.value === activeFilter),
      ),
    );

  const selectedRecord = selectedKey
    ? pageRecords.find((record) => recordKey(record) === selectedKey)
    : null;

  const actionButtons = [
    new ButtonBuilder()
      .setCustomId(
        searchCustomId(
          'approve',
          id,
          page,
          activeFilter,
          selectedRecord
            ? recordKey(selectedRecord)
            : 'none',
        ),
      )
      .setLabel('Approve')
      .setEmoji(APPROVE_EMOJI)
      .setStyle(ButtonStyle.Success)
      .setDisabled(
        !selectedRecord ||
        blacklisted,
      ),
    new ButtonBuilder()
      .setCustomId(
        searchCustomId(
          'reject',
          id,
          page,
          activeFilter,
          selectedRecord
            ? recordKey(selectedRecord)
            : 'none',
        ),
      )
      .setLabel('Reject')
      .setEmoji(REJECT_EMOJI)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(
        !selectedRecord,
      ),
  ];

  // Blacklist management is intentionally not rendered at all for ordinary
  // staff. Even if an old button is somehow available, the interaction handler
  // performs the Administrator check again.
  if (canManageBlacklist) {
    actionButtons.push(
      new ButtonBuilder()
        .setCustomId(
          searchCustomId(
            blacklisted
              ? 'unblacklist'
              : 'blacklist',
            id,
            page,
            activeFilter,
          ),
        )
        .setLabel(
          blacklisted
            ? 'UnBlacklist'
            : 'Blacklist',
        )
        .setEmoji(
          blacklisted
            ? '🔓'
            : '🚫',
        )
        .setStyle(
          blacklisted
            ? ButtonStyle.Secondary
            : ButtonStyle.Danger,
        ),
      new ButtonBuilder()
        .setCustomId(
          searchCustomId(
            'restore',
            id,
            page,
            activeFilter,
          ),
        )
        .setLabel('Restore')
        .setEmoji('♻️')
        .setStyle(
          ButtonStyle.Secondary,
        ),
    );
  }

  const actionRow =
    new ActionRowBuilder()
      .addComponents(
        actionButtons,
      );

  const pageRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        searchCustomId(
          'page-prev',
          id,
          Math.max(0, page - 1),
          activeFilter,
        ),
      )
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(
        searchCustomId(
          'page-label',
          id,
          page,
          activeFilter,
        ),
      )
      .setLabel(
        `${filterLabel(activeFilter)} • ${page + 1}/${pageCount}`,
      )
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(
        searchCustomId(
          'page-next',
          id,
          Math.min(pageCount - 1, page + 1),
          activeFilter,
        ),
      )
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );

  const components = [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(filterMenu),
    actionRow,
    pageRow,
  ];

  assertUniqueComponentCustomIds(
    components,
  );

  console.log(
    `[SKIN SEARCH] Panel for ${id} page ${page + 1}/${pageCount} built in ` +
      `${Date.now() - panelStartedAt}ms using ${searchSource}.`,
  );

  return {
    empty: false,
    page,
    pageCount,
    payload: {
      content: '',
      embeds,
      components,
      allowedMentions: { parse: [] },
    },
  };
}

function managerCustomId(action, page = 0, extra = null) {
  return [
    'skinreview',
    'manager',
    action,
    String(Math.max(0, Number(page) || 0)),
    ...(extra ? [String(extra)] : []),
  ].join(':');
}

function createSearchIdModal() {
  return new ModalBuilder()
    .setCustomId(managerCustomId('search-submit'))
    .setTitle('Search Skin / Clan ID')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('media_id')
          .setLabel('Skin / Clan / Badge ID')
          .setPlaceholder('6a5099b92064ec052cd0187b')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(24)
          .setMaxLength(24),
      ),
    );
}

function createRestoreIdModal(
  page = 0,
) {
  return new ModalBuilder()
    .setCustomId(
      managerCustomId(
        'restore-submit',
        page,
      ),
    )
    .setTitle('Restore All Media for ID')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('media_id')
          .setLabel('Skin / Clan / Badge ID')
          .setPlaceholder('6a5099b92064ec052cd0187b')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(24)
          .setMaxLength(24),
      ),
    );
}

function createBlacklistModal({
  mediaId = '',
  page = 0,
  returnFilter = FILTER_ALL,
  returnTo = 'manager',
} = {}) {
  const idInput = new TextInputBuilder()
    .setCustomId('media_id')
    .setLabel('Clan ID')
    .setPlaceholder('6a5099b92064ec052cd0187b')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(24)
    .setMaxLength(24);

  if (mediaId) {
    idInput.setValue(
      normalizeMediaId(mediaId),
    );
  }

  return new ModalBuilder()
    .setCustomId(
      [
        'skinreview',
        'blacklist-submit',
        String(Math.max(0, Number(page) || 0)),
        normalizeSearchFilter(returnFilter),
        returnTo === 'search' ? 'search' : 'manager',
      ].join(':'),
    )
    .setTitle('Blacklist Clan')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('clan_name')
          .setLabel('Clan Name')
          .setPlaceholder('KOD')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40),
      ),
      new ActionRowBuilder().addComponents(
        idInput,
      ),
    );
}

async function buildBlacklistManagerPanel(
  requestedPage = 0,
  {
    showUnblacklistMenu = false,
    notice = null,
  } = {},
) {
  const entries =
    await getBlacklistEntries();

  const pageCount =
    Math.max(
      1,
      Math.ceil(
        entries.length /
          BLACKLIST_MANAGER_PAGE_SIZE,
      ),
    );

  const page =
    Math.min(
      Math.max(
        Number(requestedPage) || 0,
        0,
      ),
      pageCount - 1,
    );

  const pageEntries =
    entries.slice(
      page *
        BLACKLIST_MANAGER_PAGE_SIZE,
      page *
        BLACKLIST_MANAGER_PAGE_SIZE +
        BLACKLIST_MANAGER_PAGE_SIZE,
    );

  const lines =
    pageEntries.map(
      (record, index) => {
        const absolute =
          page *
            BLACKLIST_MANAGER_PAGE_SIZE +
          index +
          1;

        const name =
          String(
            record.clanName ||
              record.name ||
              'Unnamed',
          );

        return (
          `**${absolute}. ${name}** | ` +
          `\`${record._id}\``
        );
      },
    );

  const embed =
    new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle('🚫 Skin / Clan Blacklist Manager')
      .setDescription(
        (notice
          ? `${notice}\n\n`
          : '') +
          `**Blacklisted IDs:** ${entries.length}\n` +
          `**Page:** ${page + 1}/${pageCount}\n\n` +
          (lines.length
            ? lines.join('\n')
            : 'No IDs are currently blacklisted.'),
      )
      .setFooter({
        text:
          'Search an ID, remove a blacklist entry, or add a clan name + ID.',
      });

  const mainActions =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          managerCustomId(
            'search',
            page,
          ),
        )
        .setLabel('Search')
        .setEmoji('🔎')
        .setStyle(
          ButtonStyle.Primary,
        ),
      new ButtonBuilder()
        .setCustomId(
          managerCustomId(
            'restore',
            page,
          ),
        )
        .setLabel('Restore ID')
        .setEmoji('♻️')
        .setStyle(
          ButtonStyle.Success,
        ),
      new ButtonBuilder()
        .setCustomId(
          managerCustomId(
            'unblacklist',
            page,
          ),
        )
        .setLabel('UnBlacklist')
        .setEmoji('🔓')
        .setStyle(
          ButtonStyle.Secondary,
        )
        .setDisabled(
          !entries.length,
        ),
      new ButtonBuilder()
        .setCustomId(
          managerCustomId(
            'blacklist',
            page,
          ),
        )
        .setLabel('Blacklist')
        .setEmoji('🚫')
        .setStyle(
          ButtonStyle.Danger,
        ),
    );

  const components = [
    mainActions,
  ];

  if (
    showUnblacklistMenu &&
    pageEntries.length
  ) {
    const select =
      new StringSelectMenuBuilder()
        .setCustomId(
          managerCustomId(
            'unblacklist-select',
            page,
          ),
        )
        .setPlaceholder(
          'Select an ID to UnBlacklist',
        )
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          pageEntries.map(
            (record) => {
              const name =
                String(
                  record.clanName ||
                    record.name ||
                    'Unnamed',
                );

              return new StringSelectMenuOptionBuilder()
                .setLabel(
                  `${name} | ${record._id}`.slice(
                    0,
                    100,
                  ),
                )
                .setDescription(
                  `Remove ${record._id} from the blacklist`.slice(
                    0,
                    100,
                  ),
                )
                .setValue(
                  String(
                    record._id,
                  ),
                )
                .setEmoji('🔓');
            },
          ),
        );

    components.push(
      new ActionRowBuilder().addComponents(
        select,
      ),
    );
  }

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(
            managerCustomId(
              'page',
              Math.max(
                0,
                page - 1,
              ),
            ),
          )
          .setEmoji('⬅️')
          .setStyle(
            ButtonStyle.Secondary,
          )
          .setDisabled(
            page <= 0,
          ),
        new ButtonBuilder()
          .setCustomId(
            managerCustomId(
              'noop',
              page,
            ),
          )
          .setLabel(
            `Page ${page + 1}/${pageCount}`,
          )
          .setStyle(
            ButtonStyle.Secondary,
          )
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(
            managerCustomId(
              'page',
              Math.min(
                pageCount - 1,
                page + 1,
              ),
            ),
          )
          .setEmoji('➡️')
          .setStyle(
            ButtonStyle.Secondary,
          )
          .setDisabled(
            page >=
              pageCount - 1,
          ),
      ),
    );
  }

  return {
    page,
    pageCount,
    payload: {
      content: '',
      embeds: [embed],
      components,
      allowedMentions: {
        parse: [],
      },
    },
  };
}

function buildStaffSearchHomePanel() {
  return {
    content: '',
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(
          '🔎 Skin / Badge Search',
        )
        .setDescription(
          `Search media posted in <#${SKIN_REVIEW_CHANNEL_ID}> by skin, clan, or badge ID.\n\n` +
            'You can **Approve** and **Reject** matching media.\n' +
            'Blacklist management is available to Administrators and authorised blacklist managers.',
        )
        .setFooter({
          text:
            'Press Search below or use /search id:<ID> for a direct lookup.',
        }),
    ],
    components: [
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              managerCustomId(
                'search',
                0,
              ),
            )
            .setLabel('Search')
            .setEmoji('🔎')
            .setStyle(
              ButtonStyle.Primary,
            ),
        ),
    ],
    allowedMentions: {
      parse: [],
    },
  };
}

async function executeSkinSearch(interaction, client) {
  const member =
    await requireSearchAccess(
      interaction,
    );

  if (!member) return;

  const canManageBlacklist =
    isSkinBlacklistManager(
      member,
    );

  const rawMediaId =
    interaction.options.getString(
      'id',
      false,
    );

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    await assertSourceChannelPermissions(
      client,
    );

    // Do not await the full startup/backfill job here.
    // Interactive searches go directly to Discord Search API.
    if (!rawMediaId) {
      if (canManageBlacklist) {
        const manager =
          await buildBlacklistManagerPanel(
            0,
          );

        await interaction.editReply(
          manager.payload,
        );
      } else {
        await interaction.editReply(
          buildStaffSearchHomePanel(),
        );
      }

      return;
    }

    const mediaId =
      normalizeMediaId(
        rawMediaId,
      );

    setBrowseSessionFilter(
      interaction,
      mediaId,
      FILTER_ALL,
    );

    const result =
      await buildSearchPanel(
        client,
        mediaId,
        0,
        null,
        FILTER_ALL,
        canManageBlacklist,
      );

    await interaction.editReply(
      result.payload,
    );
  } catch (error) {
    console.error(
      '[SKIN SEARCH ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        `I could not search the skin channel: ${
          error?.message ||
          'Unknown error'
        }`,
      embeds: [],
      components: [],
      allowedMentions: {
        parse: [],
      },
    });
  }
}

async function executeSkinContextSearch(
  interaction,
  client,
) {
  const member =
    await requireSearchAccess(
      interaction,
    );

  if (!member) return;

  const targetMessage =
    interaction.targetMessage;

  if (
    !isSourceMediaMessage(
      targetMessage,
    )
  ) {
    await interaction.reply({
      content:
        `Use **Search Associated Media** on a message in <#${SKIN_REVIEW_CHANNEL_ID}> posted by the configured media bot.`,
      flags:
        MessageFlags.Ephemeral,
      allowedMentions: {
        parse: [],
      },
    });
    return;
  }

  const entries =
    parseMediaEntries(
      targetMessage.content,
    );

  const uniqueEntries = [];
  const seenIds = new Set();

  for (const entry of entries) {
    if (
      seenIds.has(
        entry.mediaId,
      )
    ) {
      continue;
    }

    seenIds.add(
      entry.mediaId,
    );

    uniqueEntries.push(
      entry,
    );
  }

  if (!uniqueEntries.length) {
    await interaction.reply({
      content:
        'I could not find a valid skin / clan / badge ID in that message.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    await assertSourceChannelPermissions(
      client,
    );

    // Do not await the full startup/backfill job here.
    // Interactive searches go directly to Discord Search API.
    const canManageBlacklist =
      isSkinBlacklistManager(
        member,
      );

    if (
      uniqueEntries.length === 1
    ) {
      const result =
        await buildSearchPanel(
          client,
          uniqueEntries[0].mediaId,
          0,
          null,
          FILTER_ALL,
          canManageBlacklist,
        );

      await interaction.editReply(
        result.payload,
      );

      return;
    }

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(
          'skinreview:context-pick',
        )
        .setPlaceholder(
          'Select the ID to search',
        )
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          uniqueEntries
            .slice(0, 25)
            .map(
              (entry) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(
                    `${entry.typeLabel || 'Media'} • ${entry.mediaId}`.slice(
                      0,
                      100,
                    ),
                  )
                  .setDescription(
                    'Pull every skin and badge associated with this ID.',
                  )
                  .setValue(
                    entry.mediaId,
                  ),
            ),
        );

    await interaction.editReply({
      content:
        'That message contains more than one media ID. Choose which ID you want to search.',
      embeds: [],
      components: [
        new ActionRowBuilder()
          .addComponents(
            menu,
          ),
      ],
      allowedMentions: {
        parse: [],
      },
    });
  } catch (error) {
    console.error(
      '[SKIN CONTEXT SEARCH ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        `I could not search associated media: ${
          error?.message ||
          'Unknown error'
        }`,
      embeds: [],
      components: [],
    });
  }
}

async function blacklistMediaId(
  client,
  mediaId,
  userId,
  clanName,
) {
  const id =
    normalizeMediaId(mediaId);

  const name =
    normalizeClanName(clanName);

  const { blacklist } =
    await collections();

  await blacklist.updateOne(
    {
      _id: id,
    },
    {
      $set: {
        mediaId: id,
        clanName: name,
        blacklistedAt:
          new Date(),
        blacklistedBy:
          String(userId),
        channelId:
          SKIN_REVIEW_CHANNEL_ID,
      },
    },
    {
      upsert: true,
    },
  );

  let records = [];

  try {
    records =
      await getRecordsUsingDiscordSearch(
        client,
        id,
      );
  } catch (error) {
    console.error(
      '[SKIN REVIEW BLACKLIST DISCORD SEARCH ERROR]',
      error,
    );

    records =
      await getRecordsFromMongo(
        id,
      );
  }

  const messageIds = [
    ...new Set(
      records.map(
        (record) =>
          String(
            record.messageId,
          ),
      ),
    ),
  ];

  let updated = 0;

  for (
    const messageId of messageIds
  ) {
    const message =
      await fetchSourceMessage(
        client,
        messageId,
      );

    if (!message) {
      continue;
    }

    await rejectBlacklistedMessage(
      message,
    );

    updated += 1;
  }

  return updated;
}

async function restoreMediaId(
  client,
  mediaId,
  restoredById = null,
) {
  const id =
    normalizeMediaId(
      mediaId,
    );

  let records = [];

  try {
    records =
      await getRecordsUsingDiscordSearch(
        client,
        id,
      );
  } catch (error) {
    console.error(
      '[SKIN RESTORE DISCORD SEARCH ERROR]',
      error,
    );

    records =
      await getRecordsFromMongo(
        id,
      );
  }

  const messageIds =
    [
      ...new Set(
        records.map(
          (record) =>
            String(
              record.messageId,
            ),
        ),
      ),
    ];

  let restored = 0;
  let missing = 0;
  let failed = 0;
  let cursor = 0;

  const restoredMessageIds =
    [];

  // Restore a few at once so large IDs do not take ages, while still avoiding
  // an uncontrolled burst of Discord REST requests.
  async function worker() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        messageIds.length
      ) {
        return;
      }

      const messageId =
        messageIds[index];

      const message =
        await fetchSourceMessage(
          client,
          messageId,
        );

      if (!message) {
        missing += 1;
        continue;
      }

      try {
        await restoreUnblacklistedMessage(
          message,
        );

        restored += 1;

        restoredMessageIds.push(
          messageId,
        );
      } catch (error) {
        failed += 1;

        console.error(
          `[SKIN RESTORE ERROR] ${id} -> ${messageId}`,
          error,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            Math.max(
              messageIds.length,
              1,
            ),
            5,
          ),
      },
      () => worker(),
    ),
  );

  let secondaryReaction = {
    configured:
      false,
    requested:
      restoredMessageIds.length,
    reacted:
      0,
    missing:
      0,
    rejected:
      0,
    failed:
      0,
  };

  if (
    restoredMessageIds.length
  ) {
    try {
      secondaryReaction =
        await notifyRestoreReactionBot({
          channelId:
            SKIN_REVIEW_CHANNEL_ID,
          mediaId:
            id,
          messageIds:
            restoredMessageIds,
          restoredById,
        });
    } catch (error) {
      console.error(
        `[SKIN RESTORE SECONDARY REACTION ERROR] ${id}`,
        error,
      );

      secondaryReaction = {
        configured:
          true,
        requested:
          restoredMessageIds.length,
        reacted:
          0,
        missing:
          0,
        rejected:
          0,
        failed:
          restoredMessageIds.length,
      };
    }
  }

  invalidateStatusFilterCache(
    id,
  );

  console.log(
    `[SKIN RESTORE] ${id}: restored=${restored}, missing=${missing}, failed=${failed}` +
      (
        restoredById
          ? `, requestedBy=${restoredById}`
          : ''
      ) +
      (
        secondaryReaction.configured
          ? `, secondaryCheck=${secondaryReaction.reacted}/${secondaryReaction.requested}`
          : ', secondaryCheck=not-configured'
      ),
  );

  return {
    mediaId:
      id,
    total:
      messageIds.length,
    restored,
    missing,
    failed,
    secondaryReaction,
  };
}

async function unblacklistMediaId(
  mediaId,
  {
    client = null,
    restoredById = null,
    restore = false,
  } = {},
) {
  const id =
    normalizeMediaId(
      mediaId,
    );

  const { blacklist } =
    await collections();

  const result =
    await blacklist.deleteOne({
      _id:
        id,
    });

  let restoreResult = null;

  if (
    restore &&
    client
  ) {
    restoreResult =
      await restoreMediaId(
        client,
        id,
        restoredById,
      );
  }

  return {
    removed:
      result.deletedCount >
      0,
    restoreResult,
  };
}

async function showApplyingFilterState(
  interaction,
  filterValue,
) {
  const activeFilter =
    normalizeSearchFilter(
      filterValue,
    );

  const option =
    FILTER_OPTIONS.find(
      (item) =>
        item.value ===
        activeFilter,
    );

  const currentEmbeds =
    interaction.message?.embeds ||
    [];

  if (!currentEmbeds.length) {
    return;
  }

  const firstEmbed =
    EmbedBuilder.from(
      currentEmbeds[0],
    );

  firstEmbed.setTitle(
    `🔎 Skin / Badge Search • ${filterLabel(activeFilter)}`,
  );

  let description =
    String(
      currentEmbeds[0]?.description ||
      '',
    );

  const filteringLine =
    `**Filtering:** ${option?.emoji || '🔎'} **${filterLabel(activeFilter)}**`;

  if (
    /\*\*(?:Active Filter|Filtering):\*\*[^\n]*/.test(
      description,
    )
  ) {
    description =
      description.replace(
        /\*\*(?:Active Filter|Filtering):\*\*[^\n]*/,
        `**Active Filter:** ${option?.emoji || '🔎'} **${filterLabel(activeFilter)}**`,
      );
  } else if (
    /\*\*Filter:\*\*[^\n]*/.test(
      description,
    )
  ) {
    description =
      description.replace(
        /\*\*Filter:\*\*[^\n]*/,
        filteringLine,
      );
  } else {
    description =
      `${filteringLine}\n${description}`;
  }

  // The exact filtered count/page count is calculated next. Make it explicit
  // that the browser is applying the new filter instead of leaving stale All.
  if (
    /\*\*Page:\*\*[^\n]*/.test(
      description,
    )
  ) {
    description =
      description.replace(
        /\*\*Page:\*\*[^\n]*/,
        '**Page:** Calculating filtered pages…',
      );
  }

  firstEmbed.setDescription(
    description,
  );

  await interaction.editReply({
    content:
      `🔄 Applying **${filterLabel(activeFilter)}** filter…`,
    embeds: [
      firstEmbed,
    ],
    components: [],
    allowedMentions: {
      parse: [],
    },
  });
}

async function rerenderInteraction(
  interaction,
  client,
  mediaId,
  page,
  selectedKey = null,
  filterValue = FILTER_ALL,
) {
  const activeFilter =
    normalizeSearchFilter(
      filterValue,
    );

  setBrowseSessionFilter(
    interaction,
    mediaId,
    activeFilter,
  );

  const member =
    interaction.guild
      ? await interaction.guild.members
          .fetch(
            interaction.user.id,
          )
          .catch(() => null)
      : null;

  const result =
    await buildSearchPanel(
      client,
      mediaId,
      page,
      selectedKey,
      activeFilter,
      isSkinBlacklistManager(
        member,
      ),
    );

  await interaction.editReply(
    result.payload,
  );
}

async function handleSkinReviewInteraction(interaction, client) {
  if (!interaction.customId?.startsWith('skinreview:')) {
    return false;
  }

  const member =
    await requireSearchAccess(
      interaction,
    );

  if (!member) return true;

  const canManageBlacklist =
    isSkinBlacklistManager(
      member,
    );

  const parts =
    interaction.customId.split(':');

  const action = parts[1];

  try {
    await assertSourceChannelPermissions(client);
    // Do not await the full startup/backfill job here.
    // Interactive searches go directly to Discord Search API.
    if (
      action === 'context-pick' &&
      interaction.isStringSelectMenu()
    ) {
      const mediaId =
        normalizeMediaId(
          interaction.values[0],
        );

      await interaction.deferUpdate();

      setBrowseSessionFilter(
        interaction,
        mediaId,
        FILTER_ALL,
      );

      const result =
        await buildSearchPanel(
          client,
          mediaId,
          0,
          null,
          FILTER_ALL,
          canManageBlacklist,
        );

      await interaction.editReply(
        result.payload,
      );

      return true;
    }

    // ---------------------------------------------------------------
    // Plain /search blacklist-manager interactions.
    // ---------------------------------------------------------------
    if (action === 'manager') {
      const managerAction =
        parts[2] || '';

      const managerPage =
        Number(parts[3]) || 0;

      const managerSearchAction =
        managerAction === 'search' ||
        managerAction === 'search-submit';

      if (
        !managerSearchAction &&
        !canManageBlacklist
      ) {
        await requireBlacklistAdministrator(
          interaction,
          member,
        );
        return true;
      }

      if (
        managerAction === 'noop' &&
        interaction.isButton()
      ) {
        await interaction.deferUpdate();
        return true;
      }

      if (
        managerAction === 'page' &&
        interaction.isButton()
      ) {
        await interaction.deferUpdate();

        const manager =
          await buildBlacklistManagerPanel(
            managerPage,
          );

        await interaction.editReply(
          manager.payload,
        );

        return true;
      }

      if (
        managerAction === 'search' &&
        interaction.isButton()
      ) {
        await interaction.showModal(
          createSearchIdModal(),
        );

        return true;
      }

      if (
        managerAction === 'restore' &&
        interaction.isButton()
      ) {
        await interaction.showModal(
          createRestoreIdModal(
            managerPage,
          ),
        );

        return true;
      }

      if (
        managerAction === 'restore-submit' &&
        interaction.isModalSubmit()
      ) {
        const mediaId =
          normalizeMediaId(
            interaction.fields.getTextInputValue(
              'media_id',
            ),
          );

        await interaction.deferUpdate();

        const blacklistRecord =
          await getBlacklistRecord(
            mediaId,
          );

        if (blacklistRecord) {
          const manager =
            await buildBlacklistManagerPanel(
              managerPage,
              {
                notice:
                  `🚫 \`${mediaId}\` is still blacklisted. UnBlacklist it before restoring its reactions.`,
              },
            );

          await interaction.editReply(
            manager.payload,
          );

          return true;
        }

        try {
          const restoreResult =
            await restoreMediaId(
              client,
              mediaId,
              interaction.user.id,
            );

          const secondary =
            restoreResult.secondaryReaction;

          const secondarySummary =
            secondary?.configured
              ? `Connected bot: **${secondary.reacted}/${secondary.requested}** restored`
              : 'Connected bot: **not configured**';

          const manager =
            await buildBlacklistManagerPanel(
              managerPage,
              {
                notice:
                  `♻️ **Restore complete for \`${mediaId}\`**\n` +
                  `Primary bot: **${restoreResult.restored}/${restoreResult.total}** restored • ` +
                  `Missing: **${restoreResult.missing}** • Failed: **${restoreResult.failed}**\n` +
                  secondarySummary,
              },
            );

          await interaction.editReply(
            manager.payload,
          );
        } catch (error) {
          console.error(
            '[SKIN MANAGER BULK RESTORE ERROR]',
            error,
          );

          const manager =
            await buildBlacklistManagerPanel(
              managerPage,
              {
                notice:
                  `❌ Restore failed for \`${mediaId}\`: ${error?.message || 'Unknown error'}`,
              },
            );

          await interaction.editReply(
            manager.payload,
          );
        }

        return true;
      }

      if (
        managerAction === 'search-submit' &&
        interaction.isModalSubmit()
      ) {
        const mediaId =
          normalizeMediaId(
            interaction.fields.getTextInputValue(
              'media_id',
            ),
          );

        await interaction.deferUpdate();

        const result =
          await buildSearchPanel(
            client,
            mediaId,
            0,
            null,
            FILTER_ALL,
            canManageBlacklist,
          );

        await interaction.editReply(
          result.payload,
        );

        return true;
      }

      if (
        managerAction === 'blacklist' &&
        interaction.isButton()
      ) {
        await interaction.showModal(
          createBlacklistModal({
            page:
              managerPage,
            returnTo:
              'manager',
          }),
        );

        return true;
      }

      if (
        managerAction === 'unblacklist' &&
        interaction.isButton()
      ) {
        await interaction.deferUpdate();

        const manager =
          await buildBlacklistManagerPanel(
            managerPage,
            {
              showUnblacklistMenu:
                true,
            },
          );

        await interaction.editReply(
          manager.payload,
        );

        return true;
      }

      if (
        managerAction === 'unblacklist-select' &&
        interaction.isStringSelectMenu()
      ) {
        const selectedId =
          normalizeMediaId(
            interaction.values[0],
          );

        const record =
          await getBlacklistRecord(
            selectedId,
          );

        await interaction.deferUpdate();

        const unblacklistResult =
          await unblacklistMediaId(
            selectedId,
            {
              client,
              restoredById:
                interaction.user.id,
              restore:
                true,
            },
          );

        invalidateStatusFilterCache(
          selectedId,
        );

        const name =
          String(
            record?.clanName ||
              record?.name ||
              'Unnamed',
          );

        const restoreResult =
          unblacklistResult.restoreResult;

        const manager =
          await buildBlacklistManagerPanel(
            managerPage,
            {
              notice:
                `✅ UnBlacklisted **${name}** | \`${selectedId}\`.\n` +
                `♻️ Restored **${restoreResult?.restored ?? 0}/${restoreResult?.total ?? 0}** associated media item(s). ` +
                'Removed non-source ❌ reactions and restored ✔️ on the original reaction group.',
            },
          );

        await interaction.editReply(
          manager.payload,
        );

        console.log(
          `[SKIN REVIEW] ${selectedId} unblacklisted by ${interaction.user.id}.`,
        );

        return true;
      }

      return true;
    }

    // ---------------------------------------------------------------
    // Clan-name blacklist modal submission.
    // customId:
    // skinreview:blacklist-submit:{page}:{filter}:{manager|search}
    // ---------------------------------------------------------------
    if (
      action === 'blacklist-submit' &&
      interaction.isModalSubmit()
    ) {
      if (
        !(await requireBlacklistAdministrator(
          interaction,
          member,
        ))
      ) {
        return true;
      }

      const returnPage =
        Number(parts[2]) || 0;

      const returnFilter =
        normalizeSearchFilter(
          parts[3] ||
            FILTER_ALL,
        );

      const returnTo =
        parts[4] === 'search'
          ? 'search'
          : 'manager';

      const clanName =
        normalizeClanName(
          interaction.fields.getTextInputValue(
            'clan_name',
          ),
        );

      const mediaId =
        normalizeMediaId(
          interaction.fields.getTextInputValue(
            'media_id',
          ),
        );

      await interaction.deferUpdate();

      const updated =
        await blacklistMediaId(
          client,
          mediaId,
          interaction.user.id,
          clanName,
        );

      invalidateStatusFilterCache(
        mediaId,
      );

      console.log(
        `[SKIN REVIEW] ${clanName} | ${mediaId} blacklisted by ` +
          `${interaction.user.id}; ${updated} message(s) rejected.`,
      );

      if (
        returnTo === 'search'
      ) {
        await rerenderInteraction(
          interaction,
          client,
          mediaId,
          returnPage,
          null,
          returnFilter,
        );
      } else {
        const manager =
          await buildBlacklistManagerPanel(
            returnPage,
            {
              notice:
                `🚫 Blacklisted **${clanName}** | \`${mediaId}\`. ` +
                `Rejected ${updated} matching media message${updated === 1 ? '' : 's'}.`,
            },
          );

        await interaction.editReply(
          manager.payload,
        );
      }

      return true;
    }

    const mediaId =
      normalizeMediaId(
        parts[2],
      );

    const page =
      Number(parts[3]) || 0;

    const customIdFilter =
      normalizeSearchFilter(
        parts[4] ||
          FILTER_ALL,
      );

    let filterValue =
      resolveBrowseFilter(
        interaction,
        mediaId,
        customIdFilter,
      );

    // Persist the resolved value. This means every subsequent component is
    // anchored to the user's active browser filter, not an older custom ID.
    setBrowseSessionFilter(
      interaction,
      mediaId,
      filterValue,
    );

    const extra =
      parts[5] || null;

    if (
      action === 'page-label' &&
      interaction.isButton()
    ) {
      await interaction.deferUpdate();
      return true;
    }

    if (
      (action === 'page-prev' ||
        action === 'page-next') &&
      interaction.isButton()
    ) {
      await interaction.deferUpdate();

      await rerenderInteraction(
        interaction,
        client,
        mediaId,
        page,
        null,
        filterValue,
      );

      return true;
    }

    // Backwards compatibility for panels sent by the immediately previous
    // build. Once they are refreshed, they use page-prev/page-next.
    if (action === 'noop' && interaction.isButton()) {
      await interaction.deferUpdate();
      return true;
    }

    if (action === 'page' && interaction.isButton()) {
      await interaction.deferUpdate();

      await rerenderInteraction(
        interaction,
        client,
        mediaId,
        page,
        null,
        filterValue,
      );

      return true;
    }

    if (action === 'select' && interaction.isStringSelectMenu()) {
      const selectedKey = interaction.values[0];
      const selected = await getRecordByKey(mediaId, selectedKey);

      if (!selected) {
        await interaction.update({
          content: 'That media item is no longer indexed.',
          embeds: [],
          components: [],
        });
        return true;
      }

      await interaction.deferUpdate();
      await rerenderInteraction(interaction, client, mediaId, page, selectedKey, filterValue);
      return true;
    }

    if (action === 'filter' && interaction.isStringSelectMenu()) {
      const selectedFilter =
        normalizeSearchFilter(
          interaction.values[0],
        );

      // Save first. Even if the filtered panel takes a moment to build, any
      // older page/select button still resolves to this selected filter.
      setBrowseSessionFilter(
        interaction,
        mediaId,
        selectedFilter,
      );

      filterValue =
        selectedFilter;

      await interaction.deferUpdate();

      // Update the visible panel immediately so Discord never sits showing
      // "Filter: All" while Approved/Rejected reaction state is being built.
      await showApplyingFilterState(
        interaction,
        selectedFilter,
      );

      await rerenderInteraction(
        interaction,
        client,
        mediaId,
        0,
        null,
        selectedFilter,
      );
      return true;
    }

    if ((action === 'approve' || action === 'reject') && interaction.isButton()) {
      if (!extra || extra === 'none') {
        await interaction.reply({
          content: 'Select a skin / badge first.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const record = await getRecordByKey(mediaId, extra);

      if (!record) {
        await interaction.reply({
          content: 'That media item is no longer indexed.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (action === 'approve' && (await isBlacklisted(mediaId))) {
        await interaction.reply({
          content: 'This ID is blacklisted. **UnBlacklist it first** before approving media.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      await interaction.deferUpdate();

      const message = await fetchSourceMessage(client, record.messageId);

      if (!message) {
        throw new Error('The source media message no longer exists.');
      }

      if (action === 'approve') {
        await approveMessage(message);
      } else {
        await rejectMessage(message);
      }

      // The item may have moved between Pending / Approved / Rejected.
      invalidateStatusFilterCache(
        mediaId,
      );

      await rerenderInteraction(
        interaction,
        client,
        mediaId,
        page,
        null,
        filterValue,
      );
      return true;
    }

    if (action === 'blacklist' && interaction.isButton()) {
      if (
        !(await requireBlacklistAdministrator(
          interaction,
          member,
        ))
      ) {
        return true;
      }

      await interaction.showModal(
        createBlacklistModal({
          mediaId,
          page,
          returnFilter:
            filterValue,
          returnTo:
            'search',
        }),
      );
      return true;
    }

    if (action === 'unblacklist' && interaction.isButton()) {
      if (
        !(await requireBlacklistAdministrator(
          interaction,
          member,
        ))
      ) {
        return true;
      }

      await interaction.deferUpdate();

      const unblacklistResult =
        await unblacklistMediaId(
          mediaId,
          {
            client,
            restoredById:
              interaction.user.id,
            restore:
              true,
          },
        );

      invalidateStatusFilterCache(
        mediaId,
      );

      console.log(
        `[SKIN REVIEW] ${mediaId} unblacklisted by ${interaction.user.id}.`,
      );

      await rerenderInteraction(
        interaction,
        client,
        mediaId,
        page,
        null,
        filterValue,
      );

      const restoreResult =
        unblacklistResult.restoreResult;

      await interaction.followUp({
        content:
          `♻️ **${mediaId} restored** — ` +
          `**${restoreResult?.restored ?? 0}/${restoreResult?.total ?? 0}** associated media item(s) repaired. ` +
          'Non-source ❌ reactions were removed and ✔️ was restored on the original reaction group.',
        flags:
          MessageFlags.Ephemeral,
        allowedMentions: {
          parse: [],
        },
      }).catch(() => {});

      return true;
    }

    if (
      action === 'restore' &&
      interaction.isButton()
    ) {
      if (
        !(await requireBlacklistAdministrator(
          interaction,
          member,
        ))
      ) {
        return true;
      }

      const blacklistRecord =
        await getBlacklistRecord(
          mediaId,
        );

      if (blacklistRecord) {
        await interaction.reply({
          content:
            `🚫 \`${mediaId}\` is still blacklisted. Use **UnBlacklist** first; ` +
            'otherwise blacklist enforcement would immediately reject the restored media again.',
          flags:
            MessageFlags.Ephemeral,
          allowedMentions: {
            parse: [],
          },
        });

        return true;
      }

      await interaction.deferUpdate();

      try {
        const restoreResult =
          await restoreMediaId(
            client,
            mediaId,
            interaction.user.id,
          );

        await rerenderInteraction(
          interaction,
          client,
          mediaId,
          page,
          null,
          filterValue,
        );

        await interaction.followUp({
          content:
            `♻️ **Restore complete** for \`${mediaId}\`\n` +
            `• Associated media: **${restoreResult.total}**\n` +
            `• Restored: **${restoreResult.restored}**\n` +
            `• Missing/deleted: **${restoreResult.missing}**\n` +
            `• Failed: **${restoreResult.failed}**\n` +
            (
              restoreResult.secondaryReaction?.configured
                ? `• Secondary ✔️: **${restoreResult.secondaryReaction.reacted}/${restoreResult.secondaryReaction.requested}**\n\n`
                : '\n'
            ) +
            'Every non-source ❌ reaction was removed and ✔️ was restored on the original reaction group where required.',
          flags:
            MessageFlags.Ephemeral,
          allowedMentions: {
            parse: [],
          },
        });
      } catch (error) {
        console.error(
          '[SKIN MANUAL RESTORE ERROR]',
          error,
        );

        await interaction.followUp({
          content:
            `I could not restore media for \`${mediaId}\`: ${
              error?.message ||
              'Unknown error'
            }`,
          flags:
            MessageFlags.Ephemeral,
          allowedMentions: {
            parse: [],
          },
        });
      }

      return true;
    }

    return true;
  } catch (error) {
    console.error('[SKIN REVIEW INTERACTION ERROR]', error);

    const payload = {
      content: `Skin review action failed: ${error?.message || 'Unknown error'}`,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }

    return true;
  }
}

module.exports = {
  SKIN_REVIEW_CHANNEL_ID,
  PROTECTED_REACTION_BOT_ID,
  initializeSkinReview,
  executeSkinSearch,
  executeSkinContextSearch,
  handleSkinReviewInteraction,
  handleSkinReviewMessageCreate,
  handleSkinReviewMessageUpdate,
  handleSkinReviewMessageDelete,
  handleSkinReviewReactionAdd,
};
