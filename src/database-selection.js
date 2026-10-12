const { MongoClient } = require('mongodb');

function configuredDatabaseName(uri, explicitName) {
  const explicit = String(explicitName || '').trim();
  if (explicit) return explicit;
  // Only ask the driver for dbName when the URI actually names a database.
  // Otherwise the driver's implicit "test" would change the bot's old default.
  const databasePath = String(uri || '').match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/)?.[1];
  return databasePath
    ? new MongoClient(uri).options.dbName
    : 'snay_ticket_bot';
}

async function canonicalDatabaseName(client, configuredName, logger = console) {
  try {
    const escaped = configuredName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = await client.db('admin').command({
      listDatabases: 1,
      nameOnly: true,
      authorizedDatabases: true,
      filter: { name: { $regex: `^${escaped}$`, $options: 'i' } },
      maxTimeMS: 5000,
    });
    // Never search for or switch to an unrelated database. Only correct the
    // capitalisation of the selected name when exactly one existing match exists.
    const matches = (result.databases || []).filter(
      entry => typeof entry.name === 'string' &&
        entry.name.toLowerCase() === configuredName.toLowerCase(),
    );
    if (matches.length === 1) {
      const actual = matches[0].name;
      if (actual !== configuredName) {
        logger.warn(`[MONGODB] Using existing database spelling "${actual}" instead of "${configuredName}".`);
      }
      return actual;
    }
  } catch (error) {
    // Restricted accounts can still use their configured database without
    // listDatabases privileges. Do not print connection strings or credentials.
    logger.warn(`[MONGODB] Database-name check unavailable (${error?.codeName || error?.name || 'Error'}); using configured database.`);
  }
  return configuredName;
}

async function logStaffDataHealth(db, guildId, logger = console) {
  if (!guildId) return;
  const guildKey = String(guildId);
  try {
    const options = { maxTimeMS: 5000 };
    const [claims, messages, overrides, settings] = await Promise.all([
      db.collection('staff_ticket_claims').countDocuments({ guildId: guildKey }, options),
      db.collection('staff_activity_messages').countDocuments({ guildId: guildKey }, options),
      db.collection('staff_point_overrides').countDocuments({ guildId: guildKey }, options),
      db.collection('staff_tracking_settings').findOne({ _id: guildKey }, options),
    ]);
    logger.log(`[STAFF DATA CHECK] Database=${db.databaseName} guild=${guildKey} claims=${claims} messages=${messages} overrides=${overrides} savedSettings=${Boolean(settings)}`);
    if (!settings && !overrides && claims === 0) {
      logger.warn('[STAFF DATA CHECK] No saved staff setup, point overrides or ticket claims were found. If this is an existing bot, verify MONGODB_URI points to the original Atlas cluster and MONGODB_DB_NAME matches the original database in Dokploy. New messages alone do not restore historical points.');
    }
  } catch (error) {
    logger.warn(`[STAFF DATA CHECK] Could not inspect stored staff data (${error?.codeName || error?.name || 'Error'}).`);
  }
}

module.exports = { configuredDatabaseName, canonicalDatabaseName, logStaffDataHealth };
