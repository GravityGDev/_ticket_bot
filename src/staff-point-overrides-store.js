const {
  getMongoDb,
} = require('./database');
const {
  getStaffMetricCountAt,
} = require('./staff-tracking-store');
const {
  getStaffTrackingSettings,
} = require('./staff-settings-store');
const {
  POINT_PERIODS,
} = require('./staff-activity-points');

const COLLECTION =
  'staff_point_overrides';

const GLOBAL_PERIOD =
  'global';

const VALID_PERIODS =
  new Set([
    'weekly',
    'monthly',
    'quarterly',
    'lifetime',
    GLOBAL_PERIOD,
  ]);

const OVERRIDE_TYPES = Object.freeze({
  ticket: Object.freeze({
    valueField: 'ticketPoints',
    baselineField: 'ticketPointsBaselines',
    updatedByField: 'ticketPointsUpdatedBy',
    updatedAtField: 'ticketPointsUpdatedAt',
    metric: 'tickets',
    rateSetting: 'ticketClaimPoints',
    integer: false,
  }),
  message: Object.freeze({
    valueField: 'messagePoints',
    baselineField: 'messagePointsBaselines',
    updatedByField: 'messagePointsUpdatedBy',
    updatedAtField: 'messagePointsUpdatedAt',
    metric: 'messages',
    rateSetting: 'trackedMessagePoints',
    integer: false,
  }),
  ticketClaims: Object.freeze({
    valueField: 'ticketClaims',
    baselineField: 'ticketClaimsBaselines',
    updatedByField: 'ticketClaimsUpdatedBy',
    updatedAtField: 'ticketClaimsUpdatedAt',
    metric: 'tickets',
    rateSetting: null,
    integer: true,
  }),
  trackedMessages: Object.freeze({
    valueField: 'trackedMessages',
    baselineField: 'trackedMessagesBaselines',
    updatedByField: 'trackedMessagesUpdatedBy',
    updatedAtField: 'trackedMessagesUpdatedAt',
    metric: 'messages',
    rateSetting: null,
    integer: true,
  }),
});

function getOverrideConfig(
  pointType,
) {
  return OVERRIDE_TYPES[
    pointType
  ] || null;
}

function hasCompleteBaselines(
  value,
) {
  return (
    value &&
    POINT_PERIODS.every(
      (periodKey) =>
        Number.isFinite(
          value[periodKey],
        ),
    )
  );
}

async function buildAutomaticBaselines(
  guildId,
  userId,
  pointType,
  at = new Date(),
) {
  const config =
    getOverrideConfig(
      pointType,
    );

  if (!config) {
    throw new Error(
      'Invalid staff metric override type.',
    );
  }

  const settings =
    config.rateSetting
      ? await getStaffTrackingSettings(
          guildId,
        )
      : null;

  const counts =
    await Promise.all(
      POINT_PERIODS.map(
        (periodKey) =>
          getStaffMetricCountAt(
            guildId,
            userId,
            config.metric,
            periodKey,
            at,
          ),
      ),
    );

  const rate =
    config.rateSetting
      ? Number(
          settings?.[
            config.rateSetting
          ],
        ) || 0
      : 1;

  return Object.fromEntries(
    POINT_PERIODS.map(
      (
        periodKey,
        index,
      ) => [
        periodKey,
        counts[index] * rate,
      ],
    ),
  );
}

async function ensureAutomaticBaselines(
  coll,
  document,
) {
  if (!document) {
    return null;
  }

  const updates = {};

  if (
    Number.isFinite(
      document.ticketPoints,
    ) &&
    !hasCompleteBaselines(
      document.ticketPointsBaselines,
    )
  ) {
    updates.ticketPointsBaselines =
      await buildAutomaticBaselines(
        document.guildId,
        document.userId,
        'ticket',
        document.ticketPointsUpdatedAt ||
          document.updatedAt ||
          new Date(),
      );
  }

  if (
    Number.isFinite(
      document.messagePoints,
    ) &&
    !hasCompleteBaselines(
      document.messagePointsBaselines,
    )
  ) {
    updates.messagePointsBaselines =
      await buildAutomaticBaselines(
        document.guildId,
        document.userId,
        'message',
        document.messagePointsUpdatedAt ||
          document.updatedAt ||
          new Date(),
      );
  }

  if (
    Number.isFinite(
      document.ticketClaims,
    ) &&
    !hasCompleteBaselines(
      document.ticketClaimsBaselines,
    )
  ) {
    updates.ticketClaimsBaselines =
      await buildAutomaticBaselines(
        document.guildId,
        document.userId,
        'ticketClaims',
        document.ticketClaimsUpdatedAt ||
          document.updatedAt ||
          new Date(),
      );
  }

  if (
    Number.isFinite(
      document.trackedMessages,
    ) &&
    !hasCompleteBaselines(
      document.trackedMessagesBaselines,
    )
  ) {
    updates.trackedMessagesBaselines =
      await buildAutomaticBaselines(
        document.guildId,
        document.userId,
        'trackedMessages',
        document.trackedMessagesUpdatedAt ||
          document.updatedAt ||
          new Date(),
      );
  }

  if (!Object.keys(updates).length) {
    return document;
  }

  updates.baselineVersion = 1;
  updates.baselineMigratedAt =
    new Date().toISOString();

  await coll.updateOne(
    {
      _id:
        document._id,
    },
    {
      $set:
        updates,
    },
  );

  console.log(
    `[STAFF POINT OVERRIDE MIGRATION] ${document.userId}: anchored legacy manual totals so future activity can keep adding points.`,
  );

  return {
    ...document,
    ...updates,
  };
}

function cleanPeriod(
  value,
) {
  const key =
    String(
      value ||
      '',
    )
      .trim()
      .toLowerCase();

  return VALID_PERIODS.has(
    key,
  )
    ? key
    : 'weekly';
}

function finiteOrNull(
  value,
) {
  return Number.isFinite(
    value,
  )
    ? Number(
        value,
      )
    : null;
}

async function collection() {
  return (
    await getMongoDb()
  ).collection(
    COLLECTION,
  );
}

function globalDocumentId(
  guildId,
  userId,
) {
  return `${String(
    guildId,
  )}:${GLOBAL_PERIOD}:${String(
    userId,
  )}`;
}

function legacyDocumentId(
  guildId,
  userId,
  periodKey,
) {
  return `${String(
    guildId,
  )}:${cleanPeriod(
    periodKey,
  )}:${String(
    userId,
  )}`;
}

function normalize(
  document,
) {
  if (!document) {
    return null;
  }

  return {
    guildId:
      String(
        document.guildId,
      ),
    userId:
      String(
        document.userId,
      ),
    periodKey:
      GLOBAL_PERIOD,
    ticketPoints:
      finiteOrNull(
        document.ticketPoints,
      ),
    messagePoints:
      finiteOrNull(
        document.messagePoints,
      ),
    ticketClaims:
      finiteOrNull(
        document.ticketClaims,
      ),
    trackedMessages:
      finiteOrNull(
        document.trackedMessages,
      ),
    ticketPointsBaselines:
      document.ticketPointsBaselines &&
      typeof document.ticketPointsBaselines ===
        'object'
        ? Object.fromEntries(
            POINT_PERIODS.map(
              (periodKey) => [
                periodKey,
                finiteOrNull(
                  document.ticketPointsBaselines[
                    periodKey
                  ],
                ),
              ],
            ),
          )
        : null,
    messagePointsBaselines:
      document.messagePointsBaselines &&
      typeof document.messagePointsBaselines ===
        'object'
        ? Object.fromEntries(
            POINT_PERIODS.map(
              (periodKey) => [
                periodKey,
                finiteOrNull(
                  document.messagePointsBaselines[
                    periodKey
                  ],
                ),
              ],
            ),
          )
        : null,
    ticketClaimsBaselines:
      document.ticketClaimsBaselines &&
      typeof document.ticketClaimsBaselines ===
        'object'
        ? Object.fromEntries(
            POINT_PERIODS.map(
              (periodKey) => [
                periodKey,
                finiteOrNull(
                  document.ticketClaimsBaselines[
                    periodKey
                  ],
                ),
              ],
            ),
          )
        : null,
    trackedMessagesBaselines:
      document.trackedMessagesBaselines &&
      typeof document.trackedMessagesBaselines ===
        'object'
        ? Object.fromEntries(
            POINT_PERIODS.map(
              (periodKey) => [
                periodKey,
                finiteOrNull(
                  document.trackedMessagesBaselines[
                    periodKey
                  ],
                ),
              ],
            ),
          )
        : null,
    ticketPointsUpdatedAt:
      document.ticketPointsUpdatedAt ||
      (
        Number.isFinite(
          document.ticketPoints,
        )
          ? document.updatedAt ||
            null
          : null
      ),
    ticketPointsUpdatedBy:
      document.ticketPointsUpdatedBy
        ? String(
            document.ticketPointsUpdatedBy,
          )
        : (
            Number.isFinite(
              document.ticketPoints,
            ) &&
            document.updatedBy
              ? String(
                  document.updatedBy,
                )
              : null
          ),
    messagePointsUpdatedAt:
      document.messagePointsUpdatedAt ||
      (
        Number.isFinite(
          document.messagePoints,
        )
          ? document.updatedAt ||
            null
          : null
      ),
    messagePointsUpdatedBy:
      document.messagePointsUpdatedBy
        ? String(
            document.messagePointsUpdatedBy,
          )
        : (
            Number.isFinite(
              document.messagePoints,
            ) &&
            document.updatedBy
              ? String(
                  document.updatedBy,
                )
              : null
          ),
    ticketClaimsUpdatedAt:
      document.ticketClaimsUpdatedAt ||
      (
        Number.isFinite(
          document.ticketClaims,
        )
          ? document.updatedAt ||
            null
          : null
      ),
    ticketClaimsUpdatedBy:
      document.ticketClaimsUpdatedBy
        ? String(
            document.ticketClaimsUpdatedBy,
          )
        : (
            Number.isFinite(
              document.ticketClaims,
            ) &&
            document.updatedBy
              ? String(
                  document.updatedBy,
                )
              : null
          ),
    trackedMessagesUpdatedAt:
      document.trackedMessagesUpdatedAt ||
      (
        Number.isFinite(
          document.trackedMessages,
        )
          ? document.updatedAt ||
            null
          : null
      ),
    trackedMessagesUpdatedBy:
      document.trackedMessagesUpdatedBy
        ? String(
            document.trackedMessagesUpdatedBy,
          )
        : (
            Number.isFinite(
              document.trackedMessages,
            ) &&
            document.updatedBy
              ? String(
                  document.updatedBy,
                )
              : null
          ),
    updatedAt:
      document.updatedAt ||
      null,
    updatedBy:
      document.updatedBy
        ? String(
            document.updatedBy,
          )
        : null,
  };
}

async function promoteLegacyOverride(
  coll,
  guildId,
  userId,
  preferredPeriod = null,
) {
  const guildKey =
    String(
      guildId,
    );

  const userKey =
    String(
      userId,
    );

  let legacy =
    null;

  if (
    preferredPeriod &&
    cleanPeriod(
      preferredPeriod,
    ) !==
      GLOBAL_PERIOD
  ) {
    legacy =
      await coll.findOne({
        _id:
          legacyDocumentId(
            guildKey,
            userKey,
            preferredPeriod,
          ),
      });
  }

  if (!legacy) {
    legacy =
      await coll.find({
        guildId:
          guildKey,
        userId:
          userKey,
        periodKey: {
          $ne:
            GLOBAL_PERIOD,
        },
        $or: [
          {
            ticketPoints: {
              $type:
                'number',
            },
          },
          {
            messagePoints: {
              $type:
                'number',
            },
          },
        ],
      })
        .sort({
          updatedAt:
            -1,
        })
        .limit(1)
        .next();
  }

  if (!legacy) {
    return null;
  }

  const migrated = {
    guildId:
      guildKey,
    userId:
      userKey,
    periodKey:
      GLOBAL_PERIOD,
    ticketPoints:
      finiteOrNull(
        legacy.ticketPoints,
      ),
    messagePoints:
      finiteOrNull(
        legacy.messagePoints,
      ),
    ticketPointsUpdatedAt:
      legacy.ticketPointsUpdatedAt ||
      (
        Number.isFinite(
          legacy.ticketPoints,
        )
          ? legacy.updatedAt ||
            null
          : null
      ),
    ticketPointsUpdatedBy:
      legacy.ticketPointsUpdatedBy
        ? String(
            legacy.ticketPointsUpdatedBy,
          )
        : (
            Number.isFinite(
              legacy.ticketPoints,
            ) &&
            legacy.updatedBy
              ? String(
                  legacy.updatedBy,
                )
              : null
          ),
    messagePointsUpdatedAt:
      legacy.messagePointsUpdatedAt ||
      (
        Number.isFinite(
          legacy.messagePoints,
        )
          ? legacy.updatedAt ||
            null
          : null
      ),
    messagePointsUpdatedBy:
      legacy.messagePointsUpdatedBy
        ? String(
            legacy.messagePointsUpdatedBy,
          )
        : (
            Number.isFinite(
              legacy.messagePoints,
            ) &&
            legacy.updatedBy
              ? String(
                  legacy.updatedBy,
                )
              : null
          ),
    updatedAt:
      new Date().toISOString(),
    updatedBy:
      legacy.updatedBy
        ? String(
            legacy.updatedBy,
          )
        : null,
    migratedFromPeriod:
      String(
        legacy.periodKey ||
        preferredPeriod ||
        'legacy',
      ),
  };

  const setValues = {
    guildId:
      migrated.guildId,
    userId:
      migrated.userId,
    periodKey:
      GLOBAL_PERIOD,
    updatedAt:
      migrated.updatedAt,
    migratedFromPeriod:
      migrated.migratedFromPeriod,
  };

  if (
    migrated.updatedBy
  ) {
    setValues.updatedBy =
      migrated.updatedBy;
  }

  if (
    migrated.ticketPoints !==
      null
  ) {
    setValues.ticketPoints =
      migrated.ticketPoints;

    if (
      migrated.ticketPointsUpdatedAt
    ) {
      setValues.ticketPointsUpdatedAt =
        migrated.ticketPointsUpdatedAt;
    }

    if (
      migrated.ticketPointsUpdatedBy
    ) {
      setValues.ticketPointsUpdatedBy =
        migrated.ticketPointsUpdatedBy;
    }
  }

  if (
    migrated.messagePoints !==
      null
  ) {
    setValues.messagePoints =
      migrated.messagePoints;

    if (
      migrated.messagePointsUpdatedAt
    ) {
      setValues.messagePointsUpdatedAt =
        migrated.messagePointsUpdatedAt;
    }

    if (
      migrated.messagePointsUpdatedBy
    ) {
      setValues.messagePointsUpdatedBy =
        migrated.messagePointsUpdatedBy;
    }
  }

  await coll.updateOne(
    {
      _id:
        globalDocumentId(
          guildKey,
          userKey,
        ),
    },
    {
      $set:
        setValues,
    },
    {
      upsert:
        true,
    },
  );

  console.log(
    `[STAFF POINT OVERRIDE MIGRATION] ${userKey}: ` +
      `migrated ${migrated.migratedFromPeriod} override to global.`,
  );

  return normalize(
    {
      ...setValues,
    },
  );
}

async function getStaffPointOverride(
  guildId,
  userId,
  periodKey = null,
) {
  const coll =
    await collection();

  const global =
    await coll.findOne({
      _id:
        globalDocumentId(
          guildId,
          userId,
        ),
    });

  if (global) {
    return normalize(
      await ensureAutomaticBaselines(
        coll,
        global,
      ),
    );
  }

  try {
    const promoted =
      await promoteLegacyOverride(
        coll,
        guildId,
        userId,
        periodKey,
      );

    if (!promoted) {
      return null;
    }

    const promotedDocument =
      await coll.findOne({
        _id:
          globalDocumentId(
            guildId,
            userId,
          ),
      });

    return normalize(
      await ensureAutomaticBaselines(
        coll,
        promotedDocument,
      ),
    );
  } catch (error) {
    console.error(
      `[STAFF POINT OVERRIDE READ/MIGRATION ERROR] ${userId}`,
      error,
    );

    return null;
  }
}

async function getStaffPointOverridesForPeriod(
  guildId,
  periodKey = null,
) {
  const guildKey =
    String(
      guildId,
    );

  const coll =
    await collection();

  const documents =
    await coll.find({
      guildId:
        guildKey,
    }).toArray();

  const map =
    new Map();

  const usersNeedingMigration =
    new Set();

  for (
    const document of
    documents
  ) {
    const userId =
      String(
        document.userId ||
        '',
      );

    if (!userId) {
      continue;
    }

    if (
      document.periodKey ===
        GLOBAL_PERIOD ||
      String(
        document._id ||
        '',
      ) ===
        globalDocumentId(
          guildKey,
          userId,
        )
    ) {
      let anchored =
        document;

      try {
        anchored =
          await ensureAutomaticBaselines(
            coll,
            document,
          );
      } catch (error) {
        console.error(
          `[STAFF POINT BASELINE MIGRATION ERROR] ${userId}`,
          error,
        );
      }

      const value =
        normalize(
          anchored,
        );

      if (value) {
        map.set(
          userId,
          value,
        );
      }

      continue;
    }

    usersNeedingMigration.add(
      userId,
    );
  }

  for (
    const userId of
    usersNeedingMigration
  ) {
    if (
      map.has(
        userId,
      )
    ) {
      continue;
    }

    let migrated = null;

    try {
      migrated =
        await promoteLegacyOverride(
          coll,
          guildKey,
          userId,
          periodKey,
        );
    } catch (error) {
      console.error(
        `[STAFF POINT OVERRIDE MIGRATION ERROR] ${userId}`,
        error,
      );
    }

    if (migrated) {
      const promotedDocument =
        await coll.findOne({
          _id:
            globalDocumentId(
              guildKey,
              userId,
            ),
        });

      const anchored =
        await ensureAutomaticBaselines(
          coll,
          promotedDocument,
        );

      map.set(
        userId,
        normalize(
          anchored,
        ),
      );
    }
  }

  return map;
}

async function setStaffPointOverride(
  guildId,
  userId,
  periodKey,
  pointType,
  value,
  updatedBy,
) {
  const config =
    getOverrideConfig(
      pointType,
    );

  if (!config) {
    throw new Error(
      'Invalid staff metric override type.',
    );
  }

  if (
    value !==
      null &&
    (
      !Number.isFinite(
        value,
      ) ||
      value <
        0 ||
      value >
        10000000 ||
      (
        config.integer &&
        !Number.isInteger(
          value,
        )
      )
    )
  ) {
    throw new Error(
      config.integer
        ? 'Invalid staff count override value.'
        : 'Invalid staff point override value.',
    );
  }

  const coll =
    await collection();

  const id =
    globalDocumentId(
      guildId,
      userId,
    );

  const {
    valueField:
      field,
    updatedByField,
    updatedAtField,
    baselineField,
  } =
    config;

  const now =
    new Date().toISOString();

  const baseSet = {
    guildId:
      String(
        guildId,
      ),
    userId:
      String(
        userId,
      ),
    periodKey:
      GLOBAL_PERIOD,
    updatedAt:
      now,
    updatedBy:
      String(
        updatedBy,
      ),
  };

  const baselines =
    value === null
      ? null
      : await buildAutomaticBaselines(
          guildId,
          userId,
          pointType,
          now,
        );

  if (
    value ===
      null
  ) {
    await coll.updateOne(
      {
        _id:
          id,
      },
      {
        $set:
          baseSet,
        $unset: {
          [field]:
            '',
          [updatedByField]:
            '',
          [updatedAtField]:
            '',
          [baselineField]:
            '',
        },
      },
      {
        upsert:
          true,
      },
    );

    await coll.deleteOne({
      _id:
        id,
      ticketPoints: {
        $exists:
          false,
      },
      messagePoints: {
        $exists:
          false,
      },
      ticketClaims: {
        $exists:
          false,
      },
      trackedMessages: {
        $exists:
          false,
      },
    });
  } else {
    await coll.updateOne(
      {
        _id:
          id,
      },
      {
        $set: {
          ...baseSet,
          [field]:
            value,
          [updatedByField]:
            String(
              updatedBy,
            ),
          [updatedAtField]:
            now,
          [baselineField]:
            baselines,
          baselineVersion:
            1,
        },
      },
      {
        upsert:
          true,
      },
    );
  }

  console.log(
    `[STAFF METRIC OVERRIDE] ${userId}: ${pointType}=` +
      `${value === null ? 'AUTO' : value} (global) by ${updatedBy}.`,
  );

  return getStaffPointOverride(
    guildId,
    userId,
    GLOBAL_PERIOD,
  );
}

module.exports = {
  GLOBAL_PERIOD,
  getStaffPointOverride,
  getStaffPointOverridesForPeriod,
  setStaffPointOverride,
};
