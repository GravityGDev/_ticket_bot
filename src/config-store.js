const { MongoClient, ServerApiVersion } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'snay_ticket_bot';
const COLLECTION_NAME = 'server_configs';

// Kept for compatibility with ticket-system.js, which currently imports CONFIG_PATH
// for logging/error messages.
const CONFIG_PATH = `MongoDB:${MONGODB_DB_NAME}.${COLLECTION_NAME}`;

let clientPromise = null;

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

function requireMongoUri() {
  if (!MONGODB_URI) {
    throw new Error(
      'Missing MONGODB_URI environment variable. Add your MongoDB Atlas connection string in Render Environment.'
    );
  }
}

async function getClient() {
  requireMongoUri();

  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      serverSelectionTimeoutMS: 10000,
    });

    clientPromise = client.connect()
      .then(async (connectedClient) => {
        await connectedClient.db('admin').command({ ping: 1 });
        console.log(`[MONGODB] Connected. Database: ${MONGODB_DB_NAME}`);
        return connectedClient;
      })
      .catch((error) => {
        clientPromise = null;
        console.error('[MONGODB] Connection failed:', error);
        throw error;
      });
  }

  return clientPromise;
}

async function getCollection() {
  const client = await getClient();
  return client.db(MONGODB_DB_NAME).collection(COLLECTION_NAME);
}

async function getServerConfig(guildId) {
  const collection = await getCollection();

  const document = await collection.findOne({
    _id: String(guildId),
  });

  if (!document) return null;

  return normalizeGuildConfig(document);
}

async function setServerConfig(guildId, config) {
  const normalized = normalizeGuildConfig(config);
  if (!normalized) {
    throw new Error('Invalid ticket server configuration.');
  }

  const collection = await getCollection();

  await collection.updateOne(
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
  const collection = await getCollection();

  await collection.deleteOne({
    _id: String(guildId),
  });
}

async function testMongoConnection() {
  await getClient();
  return true;
}

async function closeMongoConnection() {
  if (!clientPromise) return;

  try {
    const client = await clientPromise;
    await client.close();
  } finally {
    clientPromise = null;
  }
}

module.exports = {
  CONFIG_PATH,
  getServerConfig,
  setServerConfig,
  deleteServerConfig,
  testMongoConnection,
  closeMongoConnection,
};
