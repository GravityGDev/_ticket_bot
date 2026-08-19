const { getMongoDb } = require('./database');

const COLLECTION_NAME = 'ticket_states';

function normalizeState(value) {
  if (!value || typeof value !== 'object') return null;

  return {
    guildId: value.guildId ? String(value.guildId) : null,
    number: Number.isFinite(Number(value.number)) ? Number(value.number) : null,
    typeKey: value.typeKey || null,
    creatorId: value.creatorId ? String(value.creatorId) : null,
    claimedById: value.claimedById ? String(value.claimedById) : null,
    inGameIdStatus: value.inGameIdStatus || null,
    youtubeStatus: value.youtubeStatus || null,
    staffSelectionStatus: value.staffSelectionStatus || null,
    reportedStaffId: value.reportedStaffId ? String(value.reportedStaffId) : null,
    updatedAt: value.updatedAt || null,
    updateReason: value.updateReason || null,
  };
}

async function collection() {
  return (await getMongoDb()).collection(COLLECTION_NAME);
}

async function getTicketState(channelId) {
  const document = await (await collection()).findOne({ _id: String(channelId) });
  return document ? normalizeState(document) : null;
}

async function setTicketState(channelId, state) {
  const normalized = normalizeState(state);
  if (!normalized) throw new Error('Invalid ticket state.');

  await (await collection()).updateOne(
    { _id: String(channelId) },
    {
      $set: {
        ...normalized,
        updatedAt: normalized.updatedAt || new Date().toISOString(),
      },
    },
    { upsert: true },
  );

  return normalized;
}

async function deleteTicketState(channelId) {
  await (await collection()).deleteOne({ _id: String(channelId) });
}

module.exports = {
  getTicketState,
  setTicketState,
  deleteTicketState,
};
