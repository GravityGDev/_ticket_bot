const fs = require('node:fs/promises');
const path = require('node:path');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), 'data', 'server-config.json');

let writeQueue = Promise.resolve();

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

async function ensureConfigDirectory() {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
}

async function readConfigFile() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeConfigFile(data) {
  await ensureConfigDirectory();

  const tempPath = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, CONFIG_PATH);
}

async function getServerConfig(guildId) {
  const all = await readConfigFile();
  return normalizeGuildConfig(all[String(guildId)]);
}

async function setServerConfig(guildId, config) {
  const normalized = normalizeGuildConfig(config);
  if (!normalized) throw new Error('Invalid ticket server configuration.');

  const operation = async () => {
    const all = await readConfigFile();
    all[String(guildId)] = normalized;
    await writeConfigFile(all);
    return normalized;
  };

  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

async function deleteServerConfig(guildId) {
  const operation = async () => {
    const all = await readConfigFile();
    delete all[String(guildId)];
    await writeConfigFile(all);
  };

  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

module.exports = {
  CONFIG_PATH,
  getServerConfig,
  setServerConfig,
  deleteServerConfig,
};
