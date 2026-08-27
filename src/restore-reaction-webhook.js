const DEFAULT_TIMEOUT_MS =
  25_000;

let warnedNotConfigured =
  false;

function normalizeWebhookUrl(
  value,
) {
  const raw =
    String(
      value ||
      '',
    ).trim();

  if (
    !raw
  ) {
    return '';
  }

  return raw.endsWith(
    '/restore-reaction',
  )
    ? raw
    : `${raw.replace(/\/+$/, '')}/restore-reaction`;
}

function restoreReactionWebhookConfig() {
  const url =
    normalizeWebhookUrl(
      process.env.RESTORE_REACTION_WEBHOOK_URL,
    );

  const secret =
    String(
      process.env.RESTORE_REACTION_WEBHOOK_SECRET ||
      '',
    ).trim();

  if (
    !url &&
    !secret
  ) {
    if (
      !warnedNotConfigured
    ) {
      warnedNotConfigured =
        true;

      console.warn(
        '[RESTORE REACTION WEBHOOK] Not configured; secondary ✔️ reactions are disabled.',
      );
    }

    return null;
  }

  if (
    !url ||
    !secret
  ) {
    throw new Error(
      'RESTORE_REACTION_WEBHOOK_URL and RESTORE_REACTION_WEBHOOK_SECRET must both be configured.',
    );
  }

  return {
    url,
    secret,
  };
}

async function notifyRestoreReactionBot({
  channelId,
  mediaId,
  messageIds,
  restoredById = null,
}) {
  const config =
    restoreReactionWebhookConfig();

  const uniqueMessageIds =
    [
      ...new Set(
        Array.isArray(
          messageIds,
        )
          ? messageIds.map(
              String,
            )
          : [],
      ),
    ].filter(
      (value) =>
        /^\d{16,22}$/.test(
          value,
        ),
    );

  if (
    !config
  ) {
    return {
      configured:
        false,
      requested:
        uniqueMessageIds.length,
      reacted:
        0,
      missing:
        0,
      rejected:
        0,
      failed:
        0,
    };
  }

  if (
    !uniqueMessageIds.length
  ) {
    return {
      configured:
        true,
      requested:
        0,
      reacted:
        0,
      missing:
        0,
      rejected:
        0,
      failed:
        0,
    };
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      DEFAULT_TIMEOUT_MS,
    );

  timeout.unref?.();

  try {
    const response =
      await fetch(
        config.url,
        {
          method:
            'POST',
          headers: {
            authorization:
              `Bearer ${config.secret}`,
            'content-type':
              'application/json',
          },
          body:
            JSON.stringify({
              channelId:
                String(
                  channelId,
                ),
              mediaId:
                String(
                  mediaId ||
                    '',
                ),
              messageIds:
                uniqueMessageIds,
              restoredById:
                restoredById
                  ? String(
                      restoredById,
                    )
                  : null,
            }),
          signal:
            controller.signal,
        },
      );

    const body =
      await response
        .json()
        .catch(
          () =>
            ({}),
        );

    if (
      !response.ok &&
      response.status !==
        207
    ) {
      throw new Error(
        `Secondary restore reaction bot returned HTTP ${response.status}: ` +
          String(
            body?.error ||
              'Unknown error',
          ),
      );
    }

    return {
      configured:
        true,
      requested:
        Number(
          body?.requested,
        ) ||
        uniqueMessageIds.length,
      reacted:
        Number(
          body?.reacted,
        ) ||
        0,
      missing:
        Number(
          body?.missing,
        ) ||
        0,
      rejected:
        Number(
          body?.rejected,
        ) ||
        0,
      failed:
        Number(
          body?.failed,
        ) ||
        0,
    };
  } finally {
    clearTimeout(
      timeout,
    );
  }
}

module.exports = {
  notifyRestoreReactionBot,
  restoreReactionWebhookConfig,
};
