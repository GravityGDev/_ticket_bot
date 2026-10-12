const { MongoClient, ServerApiVersion } = require('mongodb');
const { configuredDatabaseName, canonicalDatabaseName, logStaffDataHealth } = require('./database-selection');

const MONGODB_URI = process.env.MONGODB_URI;
let MONGODB_DB_NAME = configuredDatabaseName(MONGODB_URI, process.env.MONGODB_DB_NAME);

let clientPromise = null;

function requireMongoUri() {
  if (!MONGODB_URI) {
    throw new Error(
      'Missing MONGODB_URI environment variable. Add the original MongoDB Atlas connection string in Dokploy Environment.',
    );
  }
}

async function getMongoClient() {
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

    clientPromise = client
      .connect()
      .then(async (connected) => {
        await connected.db('admin').command({ ping: 1 });
        MONGODB_DB_NAME = await canonicalDatabaseName(connected, MONGODB_DB_NAME);
        console.log(`[MONGODB] Connected. Database: ${MONGODB_DB_NAME}`);
        await logStaffDataHealth(connected.db(MONGODB_DB_NAME), process.env.GUILD_ID);
        return connected;
      })
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }

  return clientPromise;
}

async function getMongoDb() {
  const client = await getMongoClient();
  return client.db(MONGODB_DB_NAME);
}

module.exports = { getMongoDb };
Object.defineProperty(module.exports, 'MONGODB_DB_NAME', { enumerable: true, get: () => MONGODB_DB_NAME });
