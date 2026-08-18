const { getMongoDb } = require('./database');

const COLLECTION_NAME = 'server_stats';

async function collection() {
  return (await getMongoDb()).collection(COLLECTION_NAME);
}

/**
 * Atomically allocate a ticket number for one Discord server.
 *
 * Each guild has one permanent MongoDB document:
 *
 * {
 *   _id: "<discord guild id>",
 *   ticketCounter: 12,
 *   totalTicketsCreated: 12,
 *   createdAt: Date,
 *   updatedAt: Date
 * }
 *
 * The counter is never reduced when a ticket is closed or deleted, so once a
 * number has been allocated it will never be allocated again for that server.
 */
async function getNextTicketNumber(guildId) {
  const guildKey = String(guildId);
  const now = new Date();

  const result = await (await collection()).findOneAndUpdate(
    { _id: guildKey },
    {
      $inc: {
        ticketCounter: 1,
        totalTicketsCreated: 1,
      },
      $set: {
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    {
      upsert: true,
      returnDocument: 'after',
      includeResultMetadata: false,
    },
  );

  // MongoDB Node driver 6/7 with includeResultMetadata:false returns the
  // document directly. Keep a fallback for older result shapes.
  const document = result?.value ?? result;
  const next = Number(document?.ticketCounter);

  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error('MongoDB did not return a valid ticket counter.');
  }

  return next;
}

async function getServerStats(guildId) {
  return (await collection()).findOne({ _id: String(guildId) });
}

module.exports = {
  getNextTicketNumber,
  getServerStats,
};
