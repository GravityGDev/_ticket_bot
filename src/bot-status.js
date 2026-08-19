const { ActivityType } = require('discord.js');
const { getBotStatus, saveBotStatus } = require('./bot-status-store');

const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

const PRESENCE_STATUSES = new Set([
  'online',
  'idle',
  'dnd',
  'invisible',
]);

function normalizeSettings(settings) {
  const message = String(settings?.message || '').trim();
  const type = String(settings?.type || 'watching').toLowerCase();
  const status = String(settings?.status || 'online').toLowerCase();

  if (!message) {
    throw new Error('Status message cannot be empty.');
  }

  if (message.length > 128) {
    throw new Error('Status message must be 128 characters or fewer.');
  }

  if (!(type in ACTIVITY_TYPES)) {
    throw new Error(`Unsupported activity type: ${type}`);
  }

  if (!PRESENCE_STATUSES.has(status)) {
    throw new Error(`Unsupported presence status: ${status}`);
  }

  return { message, type, status };
}

function buildActivity(settings) {
  if (settings.type === 'custom') {
    return {
      name: 'Custom Status',
      type: ActivityType.Custom,
      state: settings.message,
    };
  }

  return {
    name: settings.message,
    type: ACTIVITY_TYPES[settings.type],
  };
}

function applyBotStatus(client, settings) {
  if (!client?.user) {
    throw new Error('Discord client is not ready.');
  }

  const normalized = normalizeSettings(settings);

  client.user.setPresence({
    activities: [buildActivity(normalized)],
    status: normalized.status,
  });

  return normalized;
}

async function updateBotStatus(client, settings, updatedBy = null) {
  const normalized = applyBotStatus(client, settings);

  await saveBotStatus({
    ...normalized,
    updatedAt: new Date().toISOString(),
    updatedBy,
  });

  console.log(
    `[BOT STATUS] Updated to ${normalized.type}: "${normalized.message}" ` +
      `(${normalized.status}) by ${updatedBy || 'unknown'}.`,
  );

  return normalized;
}

async function applySavedBotStatus(client) {
  const saved = await getBotStatus();

  if (!saved) {
    console.log('[BOT STATUS] No saved presence found; leaving current presence unchanged.');
    return null;
  }

  const normalized = applyBotStatus(client, saved);

  console.log(
    `[BOT STATUS] Restored ${normalized.type}: "${normalized.message}" ` +
      `(${normalized.status}).`,
  );

  return normalized;
}

module.exports = {
  ACTIVITY_TYPES,
  PRESENCE_STATUSES,
  applyBotStatus,
  updateBotStatus,
  applySavedBotStatus,
};
