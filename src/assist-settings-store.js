const { getMongoDb } = require('./database');

const COLLECTION_NAME = 'bot_settings';
const DOCUMENT_PREFIX = 'ticket_assist:';

function normalizeRoleId(value) {
  const roleId = String(value || '').trim();
  return /^\d+$/.test(roleId) ? roleId : null;
}

async function collection() {
  return (await getMongoDb()).collection(COLLECTION_NAME);
}

function documentId(guildId) {
  const id = String(guildId || '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('A valid guild ID is required.');
  }
  return `${DOCUMENT_PREFIX}${id}`;
}

async function getAssistBypassRoleId(guildId) {
  if (!guildId) return null;

  const document = await (await collection()).findOne({
    _id: documentId(guildId),
  });

  return normalizeRoleId(document?.roleId);
}

async function setAssistBypassRole(guildId, roleId, updatedBy) {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) {
    throw new Error('A valid role is required.');
  }

  await (await collection()).updateOne(
    { _id: documentId(guildId) },
    {
      $set: {
        roleId: normalizedRoleId,
        updatedAt: new Date().toISOString(),
        updatedBy: String(updatedBy || '') || null,
      },
    },
    { upsert: true },
  );

  return normalizedRoleId;
}

async function removeAssistBypassRole(guildId, roleId) {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) return false;

  const result = await (await collection()).deleteOne({
    _id: documentId(guildId),
    roleId: normalizedRoleId,
  });

  return result.deletedCount > 0;
}

module.exports = {
  getAssistBypassRoleId,
  setAssistBypassRole,
  removeAssistBypassRole,
};
