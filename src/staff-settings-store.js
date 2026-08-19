const { ObjectId } = require('mongodb');
const { getMongoDb } = require('./database');

const SETTINGS_COLLECTION = 'staff_tracking_settings';
const GOALS_COLLECTION = 'staff_goals';
const GOAL_GRANTS_COLLECTION = 'staff_goal_grants';
const WARNING_REMOVALS_COLLECTION = 'staff_warning_removals';

const OWNER_USER_ID = '1150135578378125383';
const DEFAULT_TRACKED_CATEGORY_IDS = Object.freeze([
  '1194039775787745531',
  '1292633562390069281',
  '1212792701423198229',
]);

const settingsCache = new Map();
const SETTINGS_CACHE_MS = 30_000;

function uniqueSnowflakes(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(String)
      .filter((value) => /^\d{16,22}$/.test(value)),
  )];
}

function normalizePointValue(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
    return fallback;
  }
  return parsed;
}

function normalizeSettings(document, guildId) {
  return {
    guildId: String(guildId),
    trackedCategoryIds: uniqueSnowflakes(
      Array.isArray(document?.trackedCategoryIds)
        ? document.trackedCategoryIds
        : DEFAULT_TRACKED_CATEGORY_IDS,
    ),
    blacklistedChannelIds: uniqueSnowflakes(document?.blacklistedChannelIds),
    whitelistedChannelIds: uniqueSnowflakes(document?.whitelistedChannelIds),
    editorUserIds: uniqueSnowflakes(document?.editorUserIds),
    hiddenStaffUserIds: uniqueSnowflakes(document?.hiddenStaffUserIds),
    ticketClaimPoints: normalizePointValue(document?.ticketClaimPoints, 100),
    trackedMessagePoints: normalizePointValue(document?.trackedMessagePoints, 1),
    updatedAt: document?.updatedAt || null,
    updatedBy: document?.updatedBy || null,
  };
}

async function settingsCollection() {
  return (await getMongoDb()).collection(SETTINGS_COLLECTION);
}

async function goalsCollection() {
  return (await getMongoDb()).collection(GOALS_COLLECTION);
}

async function grantsCollection() {
  return (await getMongoDb()).collection(GOAL_GRANTS_COLLECTION);
}

async function warningRemovalsCollection() {
  return (await getMongoDb()).collection(WARNING_REMOVALS_COLLECTION);
}

function invalidateStaffSettings(guildId) {
  settingsCache.delete(String(guildId));
}

async function getStaffTrackingSettings(guildId, { fresh = false } = {}) {
  const guildKey = String(guildId);
  const cached = settingsCache.get(guildKey);

  if (!fresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const document = await (await settingsCollection()).findOne({ _id: guildKey });
  const value = normalizeSettings(document, guildKey);

  settingsCache.set(guildKey, {
    value,
    expiresAt: Date.now() + SETTINGS_CACHE_MS,
  });

  return value;
}

async function updateStaffTrackingSettings(guildId, patch, updatedBy) {
  const guildKey = String(guildId);
  const current = await getStaffTrackingSettings(guildKey, { fresh: true });

  const next = {
    ...current,
    ...patch,
  };

  next.trackedCategoryIds = uniqueSnowflakes(next.trackedCategoryIds);
  next.blacklistedChannelIds = uniqueSnowflakes(next.blacklistedChannelIds);
  next.whitelistedChannelIds = uniqueSnowflakes(next.whitelistedChannelIds);
  next.editorUserIds = uniqueSnowflakes(next.editorUserIds).filter(
    (id) => id !== OWNER_USER_ID,
  );
  next.hiddenStaffUserIds = uniqueSnowflakes(next.hiddenStaffUserIds);
  next.ticketClaimPoints = normalizePointValue(next.ticketClaimPoints, 100);
  next.trackedMessagePoints = normalizePointValue(next.trackedMessagePoints, 1);
  next.updatedAt = new Date();
  next.updatedBy = String(updatedBy || 'unknown');

  await (await settingsCollection()).updateOne(
    { _id: guildKey },
    {
      $set: {
        trackedCategoryIds: next.trackedCategoryIds,
        blacklistedChannelIds: next.blacklistedChannelIds,
        whitelistedChannelIds: next.whitelistedChannelIds,
        editorUserIds: next.editorUserIds,
        hiddenStaffUserIds: next.hiddenStaffUserIds,
        ticketClaimPoints: next.ticketClaimPoints,
        trackedMessagePoints: next.trackedMessagePoints,
        updatedAt: next.updatedAt,
        updatedBy: next.updatedBy,
      },
    },
    { upsert: true },
  );

  invalidateStaffSettings(guildKey);
  return getStaffTrackingSettings(guildKey, { fresh: true });
}

async function canManageStaffSettings(guildId, userId) {
  const userKey = String(userId);
  if (userKey === OWNER_USER_ID) return true;

  const settings = await getStaffTrackingSettings(guildId);
  return settings.editorUserIds.includes(userKey);
}

function parseObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

function normalizeGoalInput(input) {
  const metric = String(input.metric || '').toLowerCase();
  const period = String(input.period || '').toLowerCase();
  const threshold = Number(input.threshold);
  const rewardRoleId = String(input.rewardRoleId || '').trim();
  const name = String(input.name || '').trim();

  if (!name || name.length > 80) {
    throw new Error('Goal name must be 1-80 characters.');
  }
  if (!['tickets', 'messages'].includes(metric)) {
    throw new Error('Goal metric must be tickets or messages.');
  }
  if (!['lifetime', 'weekly', 'monthly', 'quarterly'].includes(period)) {
    throw new Error('Goal period must be lifetime, weekly, monthly, or quarterly.');
  }
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 1_000_000) {
    throw new Error('Goal threshold must be a whole number between 1 and 1,000,000.');
  }
  if (!/^\d{16,22}$/.test(rewardRoleId)) {
    throw new Error('Reward Role ID is not a valid Discord role ID.');
  }

  return { name, metric, period, threshold, rewardRoleId };
}

async function getStaffGoals(guildId) {
  return (await goalsCollection())
    .find({ guildId: String(guildId), enabled: { $ne: false } })
    .sort({ threshold: 1, name: 1 })
    .limit(25)
    .toArray();
}

async function createStaffGoal(guildId, input, createdBy) {
  const normalized = normalizeGoalInput(input);
  const now = new Date();
  const document = {
    guildId: String(guildId),
    ...normalized,
    enabled: true,
    createdAt: now,
    createdBy: String(createdBy),
    updatedAt: now,
    updatedBy: String(createdBy),
  };

  const result = await (await goalsCollection()).insertOne(document);
  return { ...document, _id: result.insertedId };
}

async function updateStaffGoal(guildId, goalId, input, updatedBy) {
  const objectId = parseObjectId(goalId);
  if (!objectId) throw new Error('Invalid goal ID.');

  const normalized = normalizeGoalInput(input);
  const result = await (await goalsCollection()).findOneAndUpdate(
    { _id: objectId, guildId: String(guildId) },
    {
      $set: {
        ...normalized,
        enabled: true,
        updatedAt: new Date(),
        updatedBy: String(updatedBy),
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!result) throw new Error('Goal not found.');

  // Editing a goal should re-evaluate it from scratch.
  await (await grantsCollection()).deleteMany({
    guildId: String(guildId),
    goalId: String(goalId),
  });

  return result;
}

async function deleteStaffGoal(guildId, goalId) {
  const objectId = parseObjectId(goalId);
  if (!objectId) throw new Error('Invalid goal ID.');

  await (await goalsCollection()).deleteOne({
    _id: objectId,
    guildId: String(guildId),
  });
  await (await grantsCollection()).deleteMany({
    guildId: String(guildId),
    goalId: String(goalId),
  });
}

async function getGoalGrant(guildId, goalId, staffId) {
  return (await grantsCollection()).findOne({
    _id: `${guildId}:${goalId}:${staffId}`,
  });
}

async function recordGoalGrant(guildId, goal, staffId, value) {
  const now = new Date();
  await (await grantsCollection()).updateOne(
    { _id: `${guildId}:${goal._id}:${staffId}` },
    {
      $setOnInsert: {
        guildId: String(guildId),
        goalId: String(goal._id),
        staffId: String(staffId),
        goalName: goal.name,
        metric: goal.metric,
        period: goal.period,
        threshold: goal.threshold,
        valueAtGrant: value,
        rewardRoleId: goal.rewardRoleId,
        grantedAt: now,
      },
    },
    { upsert: true },
  );
}

function normalizeWarningScheduleInput(input) {
  const userId = String(input.userId || '').trim();
  const roleId = String(input.roleId || '').trim();
  const executeAt = input.executeAt instanceof Date
    ? input.executeAt
    : new Date(input.executeAt);

  if (!/^\d{16,22}$/.test(userId)) {
    throw new Error('Invalid Discord user ID.');
  }
  if (!/^\d{16,22}$/.test(roleId)) {
    throw new Error('Invalid Discord role ID.');
  }
  if (Number.isNaN(executeAt.getTime())) {
    throw new Error('Invalid warning removal date/time.');
  }
  if (executeAt.getTime() <= Date.now()) {
    throw new Error('Warning removal date/time must be in the future.');
  }

  const reason = String(input.reason || '').trim().slice(0, 1000);

  return { userId, roleId, executeAt, reason };
}

async function getWarningRemovalSchedules(guildId, { includeCompleted = false } = {}) {
  const filter = { guildId: String(guildId) };
  if (!includeCompleted) filter.status = 'pending';

  return (await warningRemovalsCollection())
    .find(filter)
    .sort({ executeAt: 1 })
    .limit(25)
    .toArray();
}

async function createWarningRemovalSchedule(guildId, input, createdBy) {
  const normalized = normalizeWarningScheduleInput(input);
  const now = new Date();
  const document = {
    guildId: String(guildId),
    ...normalized,
    status: 'pending',
    createdAt: now,
    createdBy: String(createdBy),
    updatedAt: now,
    updatedBy: String(createdBy),
  };

  const result = await (await warningRemovalsCollection()).insertOne(document);
  return { ...document, _id: result.insertedId };
}

async function attachWarningMessage(
  guildId,
  scheduleId,
  channelId,
  messageId,
) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) throw new Error('Invalid schedule ID.');

  const channelKey = String(channelId || '').trim();
  const messageKey = String(messageId || '').trim();

  if (!/^\d{16,22}$/.test(channelKey)) {
    throw new Error('Invalid warning channel ID.');
  }
  if (!/^\d{16,22}$/.test(messageKey)) {
    throw new Error('Invalid warning message ID.');
  }

  const result = await (await warningRemovalsCollection()).findOneAndUpdate(
    {
      _id: objectId,
      guildId: String(guildId),
    },
    {
      $set: {
        channelId: channelKey,
        messageId: messageKey,
        messageLinkedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!result) throw new Error('Warning schedule was not found.');
  return result;
}

async function getPendingWarningMessageSchedules(limit = 500) {
  return (await warningRemovalsCollection())
    .find({
      status: 'pending',
      channelId: { $type: 'string' },
      messageId: { $type: 'string' },
    })
    .sort({ executeAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 500, 1000)))
    .toArray();
}

async function getWarningRemovalSchedule(guildId, scheduleId) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) return null;

  return (await warningRemovalsCollection()).findOne({
    _id: objectId,
    guildId: String(guildId),
  });
}

async function revokeWarningRemovalSchedule(guildId, scheduleId, revokedBy) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) throw new Error('Invalid schedule ID.');

  const result = await (await warningRemovalsCollection()).findOneAndUpdate(
    {
      _id: objectId,
      guildId: String(guildId),
      status: 'pending',
    },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: String(revokedBy),
        finishedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: String(revokedBy),
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!result) {
    throw new Error('This warning is no longer pending.');
  }

  return result;
}

async function saveWarningRevokeDetails(
  guildId,
  scheduleId,
  revokedBy,
  revokeReason,
) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) throw new Error('Invalid schedule ID.');

  const reason = String(revokeReason || '').trim().slice(0, 1000);

  if (!reason) {
    throw new Error('A revoke reason is required.');
  }

  const result = await (await warningRemovalsCollection()).findOneAndUpdate(
    {
      _id: objectId,
      guildId: String(guildId),
      status: 'pending',
    },
    {
      $set: {
        status: 'revoked',
        revokeReason: reason,
        revokedAt: new Date(),
        revokedBy: String(revokedBy),
        finishedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: String(revokedBy),
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!result) {
    throw new Error('This warning is no longer pending.');
  }

  return result;
}

async function saveWarningExtensionDetails(
  guildId,
  scheduleId,
  executeAt,
  extendedBy,
  extensionReason,
  extensionLabel,
) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) throw new Error('Invalid schedule ID.');

  const reason = String(extensionReason || '').trim().slice(0, 1000);

  if (!reason) {
    throw new Error('An extension reason is required.');
  }

  const normalized = normalizeWarningScheduleInput({
    userId: '1000000000000000',
    roleId: '1000000000000000',
    executeAt,
  });

  const now = new Date();

  const historyEntry = {
    extendedAt: now,
    extendedBy: String(extendedBy),
    reason,
    amount: String(extensionLabel || 'Custom extension').slice(0, 100),
    newExecuteAt: normalized.executeAt,
  };

  const result = await (await warningRemovalsCollection()).findOneAndUpdate(
    {
      _id: objectId,
      guildId: String(guildId),
      status: 'pending',
    },
    {
      $set: {
        executeAt: normalized.executeAt,
        lastExtensionReason: reason,
        lastExtendedBy: String(extendedBy),
        lastExtendedAt: now,
        lastExtensionAmount: historyEntry.amount,
        updatedAt: now,
        updatedBy: String(extendedBy),
      },
      $push: {
        extensionHistory: historyEntry,
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!result) {
    throw new Error('Pending warning-removal schedule not found.');
  }

  return result;
}

async function updateWarningRemovalSchedule(guildId, scheduleId, executeAt, updatedBy) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) throw new Error('Invalid schedule ID.');

  const normalized = normalizeWarningScheduleInput({
    userId: '1000000000000000',
    roleId: '1000000000000000',
    executeAt,
  });

  const result = await (await warningRemovalsCollection()).findOneAndUpdate(
    {
      _id: objectId,
      guildId: String(guildId),
      status: 'pending',
    },
    {
      $set: {
        executeAt: normalized.executeAt,
        updatedAt: new Date(),
        updatedBy: String(updatedBy),
      },
    },
    { returnDocument: 'after', includeResultMetadata: false },
  );

  if (!result) throw new Error('Pending warning-removal schedule not found.');
  return result;
}

async function deleteWarningRemovalSchedule(guildId, scheduleId) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) throw new Error('Invalid schedule ID.');

  await (await warningRemovalsCollection()).deleteOne({
    _id: objectId,
    guildId: String(guildId),
    status: 'pending',
  });
}

async function claimDueWarningRemovals(limit = 25) {
  const collection = await warningRemovalsCollection();
  const now = new Date();

  // Recover jobs that were claimed just before a process crash/redeploy.
  await collection.updateMany(
    {
      status: 'processing',
      processingAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    {
      $set: { status: 'pending' },
      $unset: { processingAt: '' },
    },
  );

  const due = await collection
    .find({ status: 'pending', executeAt: { $lte: now } })
    .sort({ executeAt: 1 })
    .limit(limit)
    .toArray();

  const claimed = [];
  for (const schedule of due) {
    const result = await collection.findOneAndUpdate(
      { _id: schedule._id, status: 'pending' },
      {
        $set: {
          status: 'processing',
          processingAt: new Date(),
        },
      },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (result) claimed.push(result);
  }

  return claimed;
}

async function finishWarningRemoval(scheduleId, status, extra = {}) {
  const objectId = parseObjectId(scheduleId);
  if (!objectId) return;

  await (await warningRemovalsCollection()).updateOne(
    { _id: objectId },
    {
      $set: {
        status,
        finishedAt: new Date(),
        ...extra,
      },
    },
  );
}

module.exports = {
  OWNER_USER_ID,
  DEFAULT_TRACKED_CATEGORY_IDS,
  getStaffTrackingSettings,
  updateStaffTrackingSettings,
  invalidateStaffSettings,
  canManageStaffSettings,
  getStaffGoals,
  createStaffGoal,
  updateStaffGoal,
  deleteStaffGoal,
  getGoalGrant,
  recordGoalGrant,
  getWarningRemovalSchedules,
  getWarningRemovalSchedule,
  getPendingWarningMessageSchedules,
  createWarningRemovalSchedule,
  attachWarningMessage,
  revokeWarningRemovalSchedule,
  saveWarningRevokeDetails,
  saveWarningExtensionDetails,
  updateWarningRemovalSchedule,
  deleteWarningRemovalSchedule,
  claimDueWarningRemovals,
  finishWarningRemoval,
};
