const { PermissionFlagsBits } = require('discord.js');
const { getMongoDb } = require('./database');

const CLAIM_COLLECTION = 'staff_ticket_claims';
const ACTIVITY_COLLECTION = 'staff_activity_messages';

const TRACKED_CATEGORY_IDS = Object.freeze([
  '1194039775787745531',
  '1292633562390069281',
]);

let indexesPromise = null;

async function claimsCollection() {
  return (await getMongoDb()).collection(CLAIM_COLLECTION);
}

async function activityCollection() {
  return (await getMongoDb()).collection(ACTIVITY_COLLECTION);
}

async function initializeStaffTracking() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const claims = await claimsCollection();
      const activity = await activityCollection();

      await Promise.all([
        claims.createIndex(
          { guildId: 1, staffId: 1, claimedAt: -1 },
          { name: 'guild_staff_claimedAt' },
        ),
        claims.createIndex(
          { guildId: 1, claimedAt: -1 },
          { name: 'guild_claimedAt' },
        ),
        activity.createIndex(
          { guildId: 1, staffId: 1, createdAt: -1 },
          { name: 'guild_staff_createdAt' },
        ),
        activity.createIndex(
          { guildId: 1, categoryId: 1, createdAt: -1 },
          { name: 'guild_category_createdAt' },
        ),
        activity.createIndex(
          { guildId: 1, channelId: 1, createdAt: -1 },
          { name: 'guild_channel_createdAt' },
        ),
      ]);

      console.log(
        `[STAFF TRACKING] Ready. Activity categories: ${TRACKED_CATEGORY_IDS.join(', ')}`,
      );
    })().catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }

  return indexesPromise;
}

function getPeriodStart(periodKey) {
  const days = {
    weekly: 7,
    monthly: 30,
    quarterly: 90,
  }[periodKey] || 7;

  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function recordTicketClaim({
  guildId,
  staffId,
  ticketNumber,
  typeKey,
  channelId,
  claimedAt = new Date(),
}) {
  await initializeStaffTracking();

  if (!guildId || !staffId || !channelId) {
    throw new Error('Missing required ticket claim tracking data.');
  }

  const document = {
    guildId: String(guildId),
    staffId: String(staffId),
    ticketNumber:
      Number.isFinite(Number(ticketNumber)) ? Number(ticketNumber) : null,
    typeKey: String(typeKey || 'unknown'),
    channelId: String(channelId),
    claimedAt:
      claimedAt instanceof Date ? claimedAt : new Date(claimedAt),
  };

  // Channel ID uniquely identifies the ticket, so this also protects against
  // accidental double-counting if a claim interaction is retried.
  await (await claimsCollection()).updateOne(
    { _id: document.channelId },
    { $setOnInsert: document },
    { upsert: true },
  );

  console.log(
    `[STAFF TRACKING] Claim recorded: staff=${document.staffId} ` +
      `ticket=#${document.ticketNumber ?? '?'} type=${document.typeKey}`,
  );
}

async function recordStaffActivityMessage(message) {
  if (!message?.guild || !message?.channel || !message.author) return false;
  if (message.author.bot) return false;

  const categoryId = String(message.channel.parentId || '');
  if (!TRACKED_CATEGORY_IDS.includes(categoryId)) return false;

  const member =
    message.member ||
    (await message.guild.members.fetch(message.author.id).catch(() => null));

  if (!member) return false;

  // The user specified that staff are identified by View Audit Log.
  if (!member.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return false;
  }

  await initializeStaffTracking();

  const createdAt = new Date(
    Number(message.createdTimestamp) || Date.now(),
  );

  const document = {
    guildId: String(message.guild.id),
    staffId: String(message.author.id),
    categoryId,
    channelId: String(message.channel.id),
    channelName: String(message.channel.name || message.channel.id),
    messageId: String(message.id),
    createdAt,
  };

  // One minimal document per Discord message makes tracking idempotent:
  // duplicate gateway delivery/restarts cannot increment the same message twice.
  const result = await (await activityCollection()).updateOne(
    { _id: document.messageId },
    { $setOnInsert: document },
    { upsert: true },
  );

  if (result.upsertedCount) {
    console.log(
      `[STAFF TRACKING] Activity recorded: staff=${document.staffId} ` +
        `channel=${document.channelId} category=${document.categoryId}`,
    );
  }

  return Boolean(result.upsertedCount);
}

async function getStaffSnapshot(guildId, periodKey) {
  await initializeStaffTracking();

  const start = getPeriodStart(periodKey);
  const guildKey = String(guildId);

  const [claimRows, activityRows] = await Promise.all([
    (await claimsCollection())
      .aggregate([
        {
          $match: {
            guildId: guildKey,
            claimedAt: { $gte: start },
          },
        },
        {
          $group: {
            _id: '$staffId',
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    (await activityCollection())
      .aggregate([
        {
          $match: {
            guildId: guildKey,
            createdAt: { $gte: start },
          },
        },
        {
          $group: {
            _id: '$staffId',
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
  ]);

  return {
    start,
    claimCounts: new Map(
      claimRows.map((row) => [String(row._id), Number(row.count) || 0]),
    ),
    messageCounts: new Map(
      activityRows.map((row) => [String(row._id), Number(row.count) || 0]),
    ),
  };
}

async function getStaffDetail(guildId, staffId, periodKey) {
  await initializeStaffTracking();

  const start = getPeriodStart(periodKey);
  const guildKey = String(guildId);
  const staffKey = String(staffId);

  const claims = await claimsCollection();
  const activity = await activityCollection();

  const [
    claimTotal,
    messageTotal,
    claimTypes,
    recentClaims,
    categoryRows,
    channelRows,
  ] = await Promise.all([
    claims.countDocuments({
      guildId: guildKey,
      staffId: staffKey,
      claimedAt: { $gte: start },
    }),
    activity.countDocuments({
      guildId: guildKey,
      staffId: staffKey,
      createdAt: { $gte: start },
    }),
    claims
      .aggregate([
        {
          $match: {
            guildId: guildKey,
            staffId: staffKey,
            claimedAt: { $gte: start },
          },
        },
        {
          $group: {
            _id: '$typeKey',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray(),
    claims
      .find({
        guildId: guildKey,
        staffId: staffKey,
        claimedAt: { $gte: start },
      })
      .sort({ claimedAt: -1 })
      .limit(6)
      .toArray(),
    activity
      .aggregate([
        {
          $match: {
            guildId: guildKey,
            staffId: staffKey,
            createdAt: { $gte: start },
          },
        },
        {
          $group: {
            _id: '$categoryId',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray(),
    activity
      .aggregate([
        {
          $match: {
            guildId: guildKey,
            staffId: staffKey,
            createdAt: { $gte: start },
          },
        },
        {
          $group: {
            _id: '$channelId',
            channelName: { $last: '$channelName' },
            categoryId: { $last: '$categoryId' },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 12 },
      ])
      .toArray(),
  ]);

  return {
    start,
    claimTotal,
    messageTotal,
    claimTypes,
    recentClaims,
    categoryRows,
    channelRows,
  };
}

module.exports = {
  TRACKED_CATEGORY_IDS,
  getPeriodStart,
  initializeStaffTracking,
  recordTicketClaim,
  recordStaffActivityMessage,
  getStaffSnapshot,
  getStaffDetail,
};
