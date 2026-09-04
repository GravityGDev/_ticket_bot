const {
  getMongoDb,
} = require('./database');

const COLLECTION_NAME =
  'ticket_states';

function stringOrNull(
  value,
) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  return String(
    value,
  );
}

function normalizeClaimHistory(
  value,
) {
  if (
    !Array.isArray(
      value,
    )
  ) {
    return [];
  }

  return value
    .map(
      (entry) => {
        const userId =
          stringOrNull(
            entry?.userId,
          );

        if (!userId) {
          return null;
        }

        const action =
          [
            'claim',
            'handover',
            'takeover',
          ].includes(
            String(
              entry?.action ||
              '',
            ),
          )
            ? String(
                entry.action,
              )
            : 'claim';

        return {
          userId,
          claimedAt:
            stringOrNull(
              entry?.claimedAt,
            ),
          previousClaimedById:
            stringOrNull(
              entry
                ?.previousClaimedById,
            ),
          action,
        };
      },
    )
    .filter(Boolean)
    .slice(
      -500,
    );
}

function normalizeAssistHistory(
  value,
) {
  if (
    !Array.isArray(
      value,
    )
  ) {
    return [];
  }

  return value
    .map(
      (entry) => {
        const staffId =
          stringOrNull(
            entry?.staffId,
          );

        if (!staffId) {
          return null;
        }

        return {
          staffId,
          addedById:
            stringOrNull(
              entry?.addedById,
            ),
          addedAt:
            stringOrNull(
              entry?.addedAt,
            ),
        };
      },
    )
    .filter(Boolean)
    .slice(
      -1000,
    );
}

function normalizeHandoverHistory(
  value,
) {
  if (
    !Array.isArray(
      value,
    )
  ) {
    return [];
  }

  return value
    .map(
      (entry) => {
        const fromStaffId =
          stringOrNull(
            entry?.fromStaffId,
          );

        const toStaffId =
          stringOrNull(
            entry?.toStaffId,
          );

        if (
          !fromStaffId ||
          !toStaffId
        ) {
          return null;
        }

        return {
          requestId:
            stringOrNull(
              entry?.requestId,
            ),
          fromStaffId,
          toStaffId,
          requestedAt:
            stringOrNull(
              entry?.requestedAt,
            ),
          acceptedAt:
            stringOrNull(
              entry?.acceptedAt,
            ),
          status:
            stringOrNull(
              entry?.status,
            ) ||
            'pending',
        };
      },
    )
    .filter(Boolean)
    .slice(
      -500,
    );
}

function normalizePendingHandover(
  value,
) {
  if (
    !value ||
    typeof value !==
      'object'
  ) {
    return null;
  }

  const fromStaffId =
    stringOrNull(
      value.fromStaffId,
    );

  const toStaffId =
    stringOrNull(
      value.toStaffId,
    );

  if (
    !fromStaffId ||
    !toStaffId
  ) {
    return null;
  }

  return {
    requestId:
      stringOrNull(
        value.requestId,
      ),
    fromStaffId,
    toStaffId,
    requestedAt:
      stringOrNull(
        value.requestedAt,
      ),
  };
}

function normalizeState(
  value,
) {
  if (
    !value ||
    typeof value !==
      'object'
  ) {
    return null;
  }

  return {
    guildId:
      stringOrNull(
        value.guildId,
      ),
    number:
      Number.isFinite(
        Number(
          value.number,
        ),
      )
        ? Number(
            value.number,
          )
        : null,
    typeKey:
      stringOrNull(
        value.typeKey,
      ),
    creatorId:
      stringOrNull(
        value.creatorId,
      ),
    creatorWasStaff:
      typeof value.creatorWasStaff === 'boolean'
        ? value.creatorWasStaff
        : null,
    claimedById:
      stringOrNull(
        value.claimedById,
      ),
    claimHistory:
      normalizeClaimHistory(
        value.claimHistory,
      ),
    assistStaffIds:
      [
        ...new Set(
          (
            Array.isArray(
              value.assistStaffIds,
            )
              ? value.assistStaffIds
              : []
          )
            .map(
              stringOrNull,
            )
            .filter(Boolean),
        ),
      ].slice(
        0,
        500,
      ),
    assistHistory:
      normalizeAssistHistory(
        value.assistHistory,
      ),
    handoverHistory:
      normalizeHandoverHistory(
        value.handoverHistory,
      ),
    pendingHandover:
      normalizePendingHandover(
        value.pendingHandover,
      ),
    controlMessageId:
      stringOrNull(
        value.controlMessageId,
      ),
    inGameIdStatus:
      stringOrNull(
        value.inGameIdStatus,
      ),
    youtubeStatus:
      stringOrNull(
        value.youtubeStatus,
      ),
    staffSelectionStatus:
      stringOrNull(
        value.staffSelectionStatus,
      ),
    reportedStaffId:
      stringOrNull(
        value.reportedStaffId,
      ),
    unmuteDecision:
      stringOrNull(
        value.unmuteDecision,
      ),
    unmuteDecisionBy:
      stringOrNull(
        value.unmuteDecisionBy,
      ),
    closedById:
      stringOrNull(
        value.closedById,
      ),
    closedAt:
      stringOrNull(
        value.closedAt,
      ),
    updatedAt:
      stringOrNull(
        value.updatedAt,
      ),
    updateReason:
      stringOrNull(
        value.updateReason,
      ),
  };
}

async function collection() {
  return (
    await getMongoDb()
  ).collection(
    COLLECTION_NAME,
  );
}

function withChannelId(
  document,
) {
  const normalized =
    normalizeState(
      document,
    );

  if (!normalized) {
    return null;
  }

  return {
    channelId:
      String(
        document._id,
      ),
    ...normalized,
  };
}

async function getTicketState(
  channelId,
) {
  const document =
    await (
      await collection()
    ).findOne({
      _id:
        String(
          channelId,
        ),
    });

  return document
    ? normalizeState(
        document,
      )
    : null;
}

async function setTicketState(
  channelId,
  state,
) {
  const normalized =
    normalizeState(
      state,
    );

  if (!normalized) {
    throw new Error(
      'Invalid ticket state.',
    );
  }

  const persisted = {
    ...normalized,
    updatedAt:
      normalized.updatedAt ||
      new Date().toISOString(),
  };

  await (
    await collection()
  ).updateOne(
    {
      _id:
        String(
          channelId,
        ),
    },
    {
      $set:
        persisted,
    },
    {
      upsert:
        true,
    },
  );

  return persisted;
}

async function getTicketStatesForCreator(
  guildId,
  creatorId,
) {
  const guildKey =
    String(
      guildId ||
      '',
    ).trim();

  const creatorKey =
    String(
      creatorId ||
      '',
    ).trim();

  if (
    !guildKey ||
    !creatorKey
  ) {
    return [];
  }

  const documents =
    await (
      await collection()
    )
      .find({
        guildId:
          guildKey,
        creatorId:
          creatorKey,
      })
      .toArray();

  return documents
    .map(
      withChannelId,
    )
    .filter(Boolean);
}

async function getTicketStatesForGuild(
  guildId,
) {
  const guildKey =
    String(
      guildId ||
      '',
    ).trim();

  if (!guildKey) {
    return [];
  }

  const documents =
    await (
      await collection()
    )
      .find({
        guildId:
          guildKey,
      })
      .toArray();

  return documents
    .map(
      withChannelId,
    )
    .filter(Boolean);
}

async function deleteTicketState(
  channelId,
) {
  await (
    await collection()
  ).deleteOne({
    _id:
      String(
        channelId,
      ),
  });
}

module.exports = {
  getTicketState,
  getTicketStatesForCreator,
  getTicketStatesForGuild,
  setTicketState,
  deleteTicketState,
};
