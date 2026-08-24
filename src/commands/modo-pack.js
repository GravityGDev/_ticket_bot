const {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

const {
  STAFF_ROLE_IDS,
  getHighestStaffRoleIndex,
  isBotDeveloper,
} = require('../staff-role-hierarchy');


const MODO_PACK_CHANNEL_ID =
  '1541522095287042208';

const {
  buildModoPackComponents,
  MIN_PACK_NUMBER,
  MAX_PACK_NUMBER,
} = require('../modo-pack');

function canCreateModoPack(member) {
  if (!member) {
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

async function isProtectedModoPackMessageAuthor(
  guild,
  message,
) {
  if (
    !message?.author
  ) {
    return false;
  }

  // Never delete this bot's own messages, including the Modo Pack panel.
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
    guild.members.cache.get(
      message.author.id,
    ) ||
    (await guild.members
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

async function deleteMessagesWithConcurrency(
  messages,
  concurrency = 3,
) {
  const list =
    [...messages];

  let cursor =
    0;

  let deleted =
    0;

  let failed =
    0;

  async function worker() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
          list.length
      ) {
        return;
      }

      const message =
        list[index];

      try {
        await message.delete();
        deleted +=
          1;
      } catch (error) {
        failed +=
          1;

        console.error(
          '[MODO PACK CHANNEL CLEANUP DELETE ERROR]',
          message?.id,
          error,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            Math.max(
              1,
              concurrency,
            ),
            Math.max(
              1,
              list.length,
            ),
          ),
      },
      () =>
        worker(),
    ),
  );

  return {
    deleted,
    failed,
  };
}

async function cleanModoPackChannel(
  interaction,
) {
  const channel =
    interaction.channel;

  if (
    !channel?.isTextBased?.() ||
    !channel?.messages?.fetch
  ) {
    throw new Error(
      'Modo Pack cleanup requires a text-based channel with message history access.',
    );
  }

  let before =
    null;

  let scanned =
    0;

  let deleted =
    0;

  let preserved =
    0;

  let failed =
    0;

  while (true) {
    const batch =
      await channel.messages.fetch({
        limit:
          100,
        ...(before
          ? {
              before,
            }
          : {}),
      });

    if (
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

    const removable =
      [];

    for (
      const message of
        ordered
    ) {
      const protectedAuthor =
        await isProtectedModoPackMessageAuthor(
          interaction.guild,
          message,
        );

      if (
        protectedAuthor
      ) {
        preserved +=
          1;

        continue;
      }

      removable.push(
        message,
      );
    }

    if (
      removable.length
    ) {
      const result =
        await deleteMessagesWithConcurrency(
          removable,
          3,
        );

      deleted +=
        result.deleted;

      failed +=
        result.failed;
    }

    if (
      batch.size <
        100
    ) {
      break;
    }
  }

  console.log(
    `[MODO PACK CHANNEL CLEANUP] Channel ${channel.id}: scanned=${scanned} deleted=${deleted} preserved=${preserved} failed=${failed}.`,
  );

  return {
    scanned,
    deleted,
    preserved,
    failed,
  };
}

function looksLikeImage(attachment) {
  if (!attachment) {
    return false;
  }

  if (
    String(
      attachment.contentType ||
      '',
    )
      .toLowerCase()
      .startsWith(
        'image/',
      )
  ) {
    return true;
  }

  return /\.(?:png|jpe?g|gif|webp|avif)$/i.test(
    String(
      attachment.name ||
      attachment.url ||
      '',
    ),
  );
}

module.exports = {
  data:
    new SlashCommandBuilder()
      .setName(
        'modo-pack',
      )
      .setDescription(
        'Post the Modo pack request panel.',
      )
      .addAttachmentOption(
        (option) =>
          option
            .setName(
              'image',
            )
            .setDescription(
              'Image to display above the pack submit button.',
            )
            .setRequired(
              true,
            ),
      ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content:
          'This command can only be used in a server.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (
      String(
        interaction.channelId ||
        '',
      ) !==
        MODO_PACK_CHANNEL_ID
    ) {
      await interaction.reply({
        content:
          'This command can only be used in <#1541522095287042208>.',
        flags:
          MessageFlags.Ephemeral,
        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    const member =
      interaction.member?.roles?.cache
        ? interaction.member
        : await interaction.guild.members
            .fetch(
              interaction.user.id,
            )
            .catch(
              () =>
                null,
            );

    if (!canCreateModoPack(member)) {
      await interaction.reply({
        content:
          'Only the **top staff role** or the bot developer can use `/modo-pack`.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    const image =
      interaction.options.getAttachment(
        'image',
        true,
      );

    if (!looksLikeImage(image)) {
      await interaction.reply({
        content:
          'The `image` option must be an image attachment.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    const imageEmbed =
      new EmbedBuilder()
        .setColor(
          0x5865f2,
        )
        .setImage(
          image.url,
        );

    const statusEmbed =
      new EmbedBuilder()
        .setColor(
          0x2b2d31,
        )
        .setDescription(
          `Press **Submit Pack** and enter a pack name from **pack${MIN_PACK_NUMBER}** to **pack${MAX_PACK_NUMBER}**. Accepted formats include pack28, Pack28, and pack28.png. Your choice will be added to the request list below.`,
        );

    await interaction.deferReply({
      flags:
        MessageFlags.Ephemeral,
    });

    let cleanupResult;

    try {
      cleanupResult =
        await cleanModoPackChannel(
          interaction,
        );
    } catch (error) {
      console.error(
        '[MODO PACK CHANNEL CLEANUP ERROR]',
        error,
      );

      await interaction.editReply(
        'I could not clean this channel. Check that I have **View Channel**, **Read Message History**, and **Manage Messages** here.',
      );

      return;
    }

    let panelMessage;

    try {
      panelMessage =
        await interaction.channel.send({
          embeds: [
            imageEmbed,
            statusEmbed,
          ],
          components:
            buildModoPackComponents(),
          allowedMentions: {
            parse: [],
          },
        });
    } catch (error) {
      console.error(
        '[MODO PACK PANEL SEND ERROR]',
        error,
      );

      await interaction.editReply(
        'The channel was cleaned, but I could not post the new Modo Pack panel.',
      );

      return;
    }

    const failureNote =
      cleanupResult.failed
        ? ` • ${cleanupResult.failed} message(s) could not be deleted`
        : '';

    await interaction.editReply(
      `✅ Modo Pack panel posted: <#${interaction.channel.id}>\n` +
      `🧹 Removed **${cleanupResult.deleted}** message(s) and preserved **${cleanupResult.preserved}** bot/top-role/developer message(s)${failureNote}.`,
    );

    console.log(
      `[MODO PACK PANEL] Posted ${panelMessage.id} in ${interaction.channel.id}; focused live cleanup remains active.`,
    );
  },
};
