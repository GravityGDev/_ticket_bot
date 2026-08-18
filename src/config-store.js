const { MONGODB_DB_NAME, getMongoDb } = require('./database');

const COLLECTION_NAME = 'server_configs';
const CONFIG_PATH = `MongoDB:${MONGODB_DB_NAME}.${COLLECTION_NAME}`;

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
  const document = await (await collection()).findOne({ _id: String(guildId) });
  return document ? normalizeGuildConfig(document) : null;
}

async function setServerConfig(guildId, config) {
  const normalized = normalizeGuildConfig(config);
  if (!normalized) throw new Error('Invalid ticket server configuration.');

  await (await collection()).updateOne(
    { _id: String(guildId) },
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
  await (await collection()).deleteOne({ _id: String(guildId) });
}

module.exports = {
  CONFIG_PATH,
  getServerConfig,
  setServerConfig,
  deleteServerConfig,
};
