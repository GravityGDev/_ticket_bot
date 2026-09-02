const { getMongoDb } = require('./database');

const COLLECTION_NAME = 'bot_settings';
const DOCUMENT_PREFIX = 'ticket_assist:';

function normalizeRoleId(value) {
  const roleId = String(value || '').trim();
  return /^\d+$/.test(roleId) ? roleId : null;
}

function normalizeRoleIds(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(normalizeRoleId).filter(Boolean))];
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

function rolesFromDocument(document) {
  return [
    ...new Set([
      ...normalizeRoleIds(document?.roleIds),
      normalizeRoleId(document?.roleId),
    ].filter(Boolean)),
  ];
}

async function getAssistBypassRoleIds(guildId) {
  if (!guildId) return [];

  const document = await (await collection()).findOne({
    _id: documentId(guildId),
  });

  return rolesFromDocument(document);
}

async function getAssistBypassRoleId(guildId) {
  return (await getAssistBypassRoleIds(guildId))[0] || null;
}

async function setAssistBypassRole(guildId, roleId, updatedBy) {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) {
    throw new Error('A valid role is required.');
  }

  const existingRoleIds = await getAssistBypassRoleIds(guildId);
  const roleIds = [...new Set([...existingRoleIds, normalizedRoleId])];

  await (await collection()).updateOne(
    { _id: documentId(guildId) },
    {
      $set: {
        roleIds,
        updatedAt: new Date().toISOString(),
        updatedBy: String(updatedBy || '') || null,
      },
      $unset: {
        roleId: '',
      },
    },
    { upsert: true },
  );

  return roleIds;
}

async function removeAssistBypassRole(guildId, roleId, updatedBy) {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) return false;

  const existingRoleIds = await getAssistBypassRoleIds(guildId);
  if (!existingRoleIds.includes(normalizedRoleId)) return false;

  const roleIds = existingRoleIds.filter((id) => id !== normalizedRoleId);
  const settingsCollection = await collection();

  if (!roleIds.length) {
    await settingsCollection.deleteOne({
      _id: documentId(guildId),
    });
    return true;
  }

  await settingsCollection.updateOne(
    { _id: documentId(guildId) },
    {
      $set: {
        roleIds,
        updatedAt: new Date().toISOString(),
        updatedBy: String(updatedBy || '') || null,
      },
      $unset: {
        roleId: '',
      },
    },
  );

  return true;
}

module.exports = {
  getAssistBypassRoleId,
  getAssistBypassRoleIds,
  setAssistBypassRole,
  removeAssistBypassRole,
};
