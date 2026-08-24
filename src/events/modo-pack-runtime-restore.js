const {
  Events,
} = require('discord.js');

const {
  isModoPackMessage,
  migrateModoPackMessage,
} = require('../modo-pack');

const MESSAGE_SCAN_LIMIT =
  100;

function isLikelyModoPackChannel(channel) {
  if (
    !channel?.isTextBased?.() ||
    !channel?.messages?.fetch
  ) {
    return false;
  }

  const name =
    String(
      channel.name ||
      '',
    ).toLowerCase();

  return (
    name.includes(
      'modo-pack',
    ) ||
    name.includes(
      'modo_packs',
    ) ||
    name.includes(
      'modopack',
    )
  );
}

module.exports = {
  name:
    Events.ClientReady,

  once:
    true,

  async execute(
    client,
  ) {
    let scanned =
      0;

    let migrated =
      0;

    for (
      const guild of
        client.guilds.cache.values()
    ) {
      for (
        const channel of
          guild.channels.cache.values()
      ) {
        if (
          !isLikelyModoPackChannel(
            channel,
          )
        ) {
          continue;
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
          continue;
        }

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
      }
    }

    console.log(
      `[MODO PACK STARTUP] Checked ${scanned} Modo pack message(s); cleaned ${migrated}.`,
    );
  },
};
