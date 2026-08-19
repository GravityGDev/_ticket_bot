const { getMongoDb } = require('./database');

const COLLECTION_NAME = 'bot_settings';
const STATUS_DOCUMENT_ID = 'presence';

async function collection() {
  return (await getMongoDb()).collection(COLLECTION_NAME);
}

function normalizeBotStatus(value) {
  if (!value || typeof value !== 'object') return null;

  const message = String(value.message || '').trim();
  if (!message) return null;

  const type = String(value.type || 'watching').toLowerCase();
  const status = String(value.status || 'online').toLowerCase();

  return {
    message,
    type,
    status,
    updatedAt: value.updatedAt || null,
    updatedBy: value.updatedBy || null,
  };
}

async function getBotStatus() {
  const document = await (await collection()).findOne({
    _id: STATUS_DOCUMENT_ID,
  });

  return document ? normalizeBotStatus(document) : null;
}

async function saveBotStatus(settings) {
  const normalized = normalizeBotStatus(settings);

  if (!normalized) {
    throw new Error('Invalid bot status settings.');
  }

  await (await collection()).updateOne(
    { _id: STATUS_DOCUMENT_ID },
    {
      $set: {
        message: normalized.message,
        type: normalized.type,
        status: normalized.status,
        updatedAt: normalized.updatedAt || new Date().toISOString(),
        updatedBy: normalized.updatedBy || null,
      },
    },
    { upsert: true },
  );

  return normalized;
}

module.exports = {
  getBotStatus,
  saveBotStatus,
};
