const { MONGODB_DB_NAME, getMongoDb } = require('./database');

const COLLECTION_NAME = 'server_configs';
const SHARED_COLLECTION = 'bot_settings';
const CONFIG_PATH = `MongoDB:${MONGODB_DB_NAME}.${SHARED_COLLECTION}`;
const configId = guildId => `ticket_config:${String(guildId)}`;

function normalizeGuildConfig(value) {
  if (!value || typeof value !== 'object') return null;
  if (!/^\d+$/.test(String(value.categoryId || ''))) return null;

  const roleIds = Array.isArray(value.roleIds)
    ? [...new Set(value.roleIds.map(String).filter((id) => /^\d+$/.test(id)))]
    : [];

  return {
    categoryId: String(value.categoryId),
    roleIds,
    updatedAt: value.updatedAt || null,
    updatedBy: value.updatedBy || null,
  };
}

async function collection() {
  return (await getMongoDb()).collection(COLLECTION_NAME);
}

async function getServerConfig(guildId) {
  const db = await getMongoDb();
  const shared = await db.collection(SHARED_COLLECTION).findOne({ _id: configId(guildId) });
  if (shared) return normalizeGuildConfig(shared);
  // Keep existing setups readable. Reading an absent collection does not create
  // it, and all new writes reuse bot_settings at the Atlas collection limit.
  const legacy = await db.collection(COLLECTION_NAME).findOne({ _id: String(guildId) });
  return normalizeGuildConfig(legacy);
}

async function setServerConfig(guildId, config) {
  const normalized = normalizeGuildConfig(config);
  if (!normalized) throw new Error('Invalid ticket server configuration.');

  await (await getMongoDb()).collection(SHARED_COLLECTION).updateOne(
    { _id: configId(guildId) },
    {
      $set: {
        categoryId: normalized.categoryId,
        roleIds: normalized.roleIds,
        updatedAt: normalized.updatedAt || new Date().toISOString(),
        updatedBy: normalized.updatedBy,
      },
    },
    { upsert: true },
  );

  return normalized;
}

async function deleteServerConfig(guildId) {
  await (await getMongoDb()).collection(SHARED_COLLECTION).deleteOne({ _id: configId(guildId) });
  await (await collection()).deleteOne({ _id: String(guildId) });
}

module.exports = {
  CONFIG_PATH,
  getServerConfig,
  setServerConfig,
  deleteServerConfig,
};
