const {
  Events,
} = require('discord.js');

const {
  STAFF_ROLE_IDS,
  getHighestStaffRoleIndex,
  isBotDeveloper,
} = require('../staff-role-hierarchy');


const FOCUSED_MODO_PACK_CHANNEL_ID =
  '1541522095287042208';

async function isProtectedModoPackAuthor(
  message,
) {
  if (
    !message?.guild ||
    !message?.author
  ) {
    return true;
  }

  // Never delete this bot's own messages.
  if (
    message.client?.user?.id &&
    String(
      message.author.id,
    ) ===
      String(
        message.client.user.id,
      )
  ) {
    return true;
  }

  const member =
    message.member ||
    message.guild.members.cache.get(
      message.author.id,
    ) ||
    (await message.guild.members
      .fetch(
        message.author.id,
      )
      .catch(
        () =>
          null,
      ));

  if (
    !member
  ) {
    return false;
  }

  if (
    isBotDeveloper(
      member,
    )
  ) {
    return true;
  }

  const highestRoleIndex =
    getHighestStaffRoleIndex(
      member,
    );

  return (
    Number.isInteger(
      highestRoleIndex,
    ) &&
    highestRoleIndex ===
      STAFF_ROLE_IDS.length - 1
  );
}

async function removeIfUnprotected(
  message,
) {
  if (
    !message?.guild ||
    !message?.channel
  ) {
    return false;
  }

  const channelId =
    String(
      message.channel.id,
    );

  if (
    channelId !==
      FOCUSED_MODO_PACK_CHANNEL_ID
  ) {
    return false;
  }

  const protectedMessage =
    await isProtectedModoPackAuthor(
      message,
    );

  if (
    protectedMessage
  ) {
    return false;
  }

  await message
    .delete()
    .catch(
      (error) => {
        console.error(
          '[MODO PACK LIVE CLEANER DELETE ERROR]',
          message.id,
          error,
        );

        return null;
      },
    );

  console.log(
    `[MODO PACK LIVE CLEANER] Removed message ${message.id} from ${channelId} by ${message.author?.id || 'unknown'}.`,
  );

  return true;
}

async function cleanExistingFocusedChannel(
  client,
) {
  const channel =
    await client.channels
      .fetch(
        FOCUSED_MODO_PACK_CHANNEL_ID,
      )
      .catch(
        () =>
          null,
      );

  if (
    !channel?.isTextBased?.() ||
    !channel?.messages?.fetch
  ) {
    console.warn(
      '[MODO PACK STARTUP CLEAN] Focused channel is unavailable or not text based.',
    );

    return;
  }

  let before =
    null;

  let scanned =
    0;

  let removed =
    0;

  let preserved =
    0;

  while (true) {
    const batch =
      await channel.messages
        .fetch({
          limit:
            100,
          ...(before
            ? {
                before,
              }
            : {}),
        })
        .catch(
          (error) => {
            console.error(
              '[MODO PACK STARTUP CLEAN FETCH ERROR]',
              error,
            );

            return null;
          },
        );

    if (
      !batch ||
      !batch.size
    ) {
      break;
    }

    scanned +=
      batch.size;

    const ordered =
      [...batch.values()];

    before =
      ordered[
        ordered.length - 1
      ]?.id ||
      null;

    for (
      const message of
        ordered
    ) {
      const protectedMessage =
        await isProtectedModoPackAuthor(
          message,
        );

      if (
        protectedMessage
      ) {
        preserved +=
          1;

        continue;
      }

      const deleted =
        await message
          .delete()
          .then(
            () =>
              true,
          )
          .catch(
            (error) => {
              console.error(
                '[MODO PACK STARTUP CLEAN DELETE ERROR]',
                message.id,
                error,
              );

              return false;
            },
          );

      if (
        deleted
      ) {
        removed +=
          1;
      }
    }

    if (
      batch.size <
        100
    ) {
      break;
    }
  }

  console.log(
    `[MODO PACK STARTUP CLEAN] Focused channel ${FOCUSED_MODO_PACK_CHANNEL_ID} scanned=${scanned} removed=${removed} preserved=${preserved}.`,
  );
}

module.exports = {
  name:
    Events.MessageCreate,

  async execute(
    message,
  ) {
    await removeIfUnprotected(
      message,
    );
  },

  // Exported helpers are used by the separate startup event below.
  removeIfUnprotected,
  cleanExistingFocusedChannel,
};
