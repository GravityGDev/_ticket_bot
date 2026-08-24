const {
  Events,
} = require('discord.js');

const {
  isModoPackMessage,
  migrateModoPackMessage,
} = require('../modo-pack');

const FOCUSED_MODO_PACK_CHANNEL_ID =
  '1541522095287042208';

const MESSAGE_SCAN_LIMIT =
  100;

module.exports = {
  name:
    Events.ClientReady,

  once:
    true,

  async execute(
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
        '[MODO PACK STARTUP] Focused Modo Pack channel unavailable.',
      );

      return;
    }

    const messages =
      await channel.messages
        .fetch({
          limit:
            MESSAGE_SCAN_LIMIT,
        })
        .catch(
          (error) => {
            console.error(
              '[MODO PACK STARTUP SCAN ERROR]',
              channel.id,
              error,
            );

            return null;
          },
        );

    if (
      !messages
    ) {
      return;
    }

    let scanned =
      0;

    let migrated =
      0;

    for (
      const message of
        messages.values()
    ) {
      if (
        message.author?.id !==
          client.user.id ||
        !isModoPackMessage(
          message,
        )
      ) {
        continue;
      }

      scanned +=
        1;

      const changed =
        await migrateModoPackMessage(
          message,
        ).catch(
          (error) => {
            console.error(
              '[MODO PACK STARTUP MIGRATION ERROR]',
              message.id,
              error,
            );

            return false;
          },
        );

      if (
        changed
      ) {
        migrated +=
          1;
      }
    }

    console.log(
      `[MODO PACK STARTUP] Focused channel checked ${scanned} Modo pack message(s); cleaned ${migrated}.`,
    );
  },
};
