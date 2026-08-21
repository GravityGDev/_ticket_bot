const {
  getMongoDb,
} = require('./database');

const COLLECTION =
  'staff_point_overrides';

const VALID_PERIODS =
  new Set([
    'weekly',
    'monthly',
    'quarterly',
    'lifetime',
  ]);

function cleanPeriod(value) {
  const key =
    String(value || '')
      .trim()
      .toLowerCase();

  return VALID_PERIODS.has(key)
    ? key
    : 'weekly';
}

function finiteOrNull(value) {
  return Number.isFinite(value)
    ? Number(value)
    : null;
}

async function collection() {
  return (
    await getMongoDb()
  ).collection(COLLECTION);
}

function documentId(
  guildId,
  userId,
  periodKey,
) {
  return `${String(guildId)}:${cleanPeriod(periodKey)}:${String(userId)}`;
}

function normalize(document) {
  if (!document) {
    return null;
  }

  return {
    guildId:
      String(document.guildId),
    userId:
      String(document.userId),
    periodKey:
      cleanPeriod(document.periodKey),
    ticketPoints:
      finiteOrNull(document.ticketPoints),
    messagePoints:
      finiteOrNull(document.messagePoints),
    updatedAt:
      document.updatedAt || null,
    updatedBy:
      document.updatedBy
        ? String(document.updatedBy)
        : null,
  };
}

async function getStaffPointOverridesForPeriod(
  guildId,
  periodKey,
) {
  const period =
    cleanPeriod(periodKey);

  const documents =
    await (
      await collection()
    )
      .find({
        guildId:
          String(guildId),
        periodKey:
          period,
      })
      .toArray();

  const map =
    new Map();

  for (
    const document of
    documents
  ) {
    const value =
      normalize(document);

    if (!value) {
      continue;
    }

    map.set(
      value.userId,
      value,
    );
  }

  return map;
}

async function getStaffPointOverride(
  guildId,
  userId,
  periodKey,
) {
  const document =
    await (
      await collection()
    ).findOne({
      _id:
        documentId(
          guildId,
          userId,
          periodKey,
        ),
    });

  return normalize(document);
}

async function setStaffPointOverride(
  guildId,
  userId,
  periodKey,
  pointType,
  value,
  updatedBy,
) {
  if (
    !['ticket', 'message'].includes(
      pointType,
    )
  ) {
    throw new Error(
      'Invalid staff point override type.',
    );
  }

  if (
    value !== null &&
    (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 10000000
    )
  ) {
    throw new Error(
      'Invalid staff point override value.',
    );
  }

  const period =
    cleanPeriod(periodKey);
  const id =
    documentId(
      guildId,
      userId,
      period,
    );
  const field =
    pointType === 'ticket'
      ? 'ticketPoints'
      : 'messagePoints';
  const coll =
    await collection();

  const baseSet = {
    guildId:
      String(guildId),
    userId:
      String(userId),
    periodKey:
      period,
    updatedAt:
      new Date().toISOString(),
    updatedBy:
      String(updatedBy),
  };

  if (value === null) {
    await coll.updateOne(
      { _id: id },
      {
        $set:
          baseSet,
        $unset: {
          [field]: '',
        },
      },
      { upsert: true },
    );

    await coll.deleteOne({
      _id: id,
      ticketPoints: {
        $exists: false,
      },
      messagePoints: {
        $exists: false,
      },
    });
  } else {
    await coll.updateOne(
      { _id: id },
      {
        $set: {
          ...baseSet,
          [field]:
            value,
        },
      },
      { upsert: true },
    );
  }

  return getStaffPointOverride(
    guildId,
    userId,
    period,
  );
}

module.exports = {
  getStaffPointOverride,
  getStaffPointOverridesForPeriod,
  setStaffPointOverride,
};
