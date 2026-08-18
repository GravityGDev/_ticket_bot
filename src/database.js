const { MongoClient, ServerApiVersion } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'snay_ticket_bot';

let clientPromise = null;

function requireMongoUri() {
  if (!MONGODB_URI) {
    throw new Error(
      'Missing MONGODB_URI environment variable. Add the MongoDB Atlas connection string in Render Environment.',
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
        console.log(`[MONGODB] Connected. Database: ${MONGODB_DB_NAME}`);
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

module.exports = {
  MONGODB_DB_NAME,
  getMongoDb,
};
