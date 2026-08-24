const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const MIN_PACK_NUMBER =
  5;

const MAX_PACK_NUMBER =
  102;

const SUBMIT_BUTTON_ID =
  'modo_pack_submit';

const MODAL_ID =
  'modo_pack_modal';

const INPUT_ID =
  'modo_pack_name';

function buildModoPackComponents() {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            SUBMIT_BUTTON_ID,
          )
          .setLabel(
            'Submit Pack',
          )
          .setEmoji(
            '📦',
          )
          .setStyle(
            ButtonStyle.Primary,
          ),
      ),
  ];
}

function normalizePackName(value) {
  return String(
    value ||
    '',
  ).trim();
}

function parseValidPackName(value) {
  const rawPackName =
    normalizePackName(
      value,
    );

  // Accepted examples:
  // pack5
  // Pack5
  // PACK5
  // pack5.png
  // Pack5.PNG
  //
  // Everything is normalized back to the canonical form: pack5.
  const match =
    /^pack(\d+)(?:\.png)?$/i.exec(
      rawPackName,
    );

  if (!match) {
    return null;
  }

  const number =
    Number.parseInt(
      match[1],
      10,
    );

  if (
    !Number.isInteger(
      number,
    ) ||
    number <
      MIN_PACK_NUMBER ||
    number >
      MAX_PACK_NUMBER
  ) {
    return null;
  }

  // Prevent zero-padded forms such as pack05 or pack005.png.
  if (
    String(
      match[1],
    ) !==
    String(
      number,
    )
  ) {
    return null;
  }

  return {
    number,
    packName:
      `pack${number}`,
  };
}

function sanitizeModoPackDisplayName(value) {
  return String(
    value ||
    'Unknown User',
  )
    .replace(
      /[\r\n|]/g,
      ' ',
    )
    .replace(
      /\s+/g,
      ' ',
    )
    .trim()
    .slice(
      0,
      60,
    ) ||
    'Unknown User';
}

function parseModoPackEntries(embed) {
  const footerText =
    String(
      embed?.footer?.text ||
      '',
    );

  const prefix =
    'modo-pack-state:';

  if (
    !footerText.startsWith(
      prefix,
    )
  ) {
    return [];
  }

  try {
    const decoded =
      JSON.parse(
        Buffer.from(
          footerText.slice(
            prefix.length,
          ),
          'base64url',
        ).toString(
          'utf8',
        ),
      );

    if (
      !Array.isArray(
        decoded,
      )
    ) {
      return [];
    }

    return decoded
      .filter(
        (entry) =>
          entry &&
          entry.userId &&
          entry.packName,
      )
      .map(
        (entry) => ({
          userId:
            String(
              entry.userId,
            ),
          displayName:
            sanitizeModoPackDisplayName(
              entry.displayName,
            ),
          packName:
            String(
              entry.packName,
            ),
        }),
      );
  } catch {
    return [];
  }
}

function encodeModoPackEntries(entries) {
  const compact =
    entries.map(
      (entry) => ({
        userId:
          String(
            entry.userId,
          ),
        displayName:
          sanitizeModoPackDisplayName(
            entry.displayName,
          ),
        packName:
          String(
            entry.packName,
          ),
      }),
    );

  return (
    'modo-pack-state:' +
    Buffer.from(
      JSON.stringify(
        compact,
      ),
      'utf8',
    ).toString(
      'base64url',
    )
  );
}

function buildModoPackListDescription(entries) {
  if (
    !entries.length
  ) {
    return 'No pack requests yet.';
  }

  return entries
    .map(
      (entry) =>
        `> ${sanitizeModoPackDisplayName(
          entry.displayName,
        )} | ${entry.packName}`,
    )
    .join(
      '\n',
    )
    .slice(
      0,
      4096,
    );
}

function getImageEmbed(message) {
  const firstEmbed =
    message?.embeds?.[0];

  if (!firstEmbed) {
    return null;
  }

  return EmbedBuilder.from(
    firstEmbed,
  );
}

async function openPackModal(
  interaction,
) {
  const modal =
    new ModalBuilder()
      .setCustomId(
        `${MODAL_ID}:${interaction.message.id}`,
      )
      .setTitle(
        'Submit Modo Pack',
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        INPUT_ID,
      )
      .setLabel(
        'Pack name',
      )
      .setPlaceholder(
        'pack28 or pack28.png',
      )
      .setStyle(
        TextInputStyle.Short,
      )
      .setMinLength(
        5,
      )
      .setMaxLength(
        11,
      )
      .setRequired(
        true,
      );

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input,
      ),
  );

  await interaction.showModal(
    modal,
  );

  return true;
}

async function submitPackModal(
  interaction,
) {
  const requestedPack =
    interaction.fields.getTextInputValue(
      INPUT_ID,
    );

  const parsed =
    parseValidPackName(
      requestedPack,
    );

  if (!parsed) {
    await interaction.reply({
      content:
        `Enter a valid pack name from pack${MIN_PACK_NUMBER} to pack${MAX_PACK_NUMBER} — for example pack28, Pack28, or pack28.png.`,
      flags:
        MessageFlags.Ephemeral,
    });

    return true;
  }

  const messageId =
    String(
      interaction.customId,
    ).split(
      ':',
    )[1];

  if (!messageId) {
    await interaction.reply({
      content:
        'I could not identify the Modo pack message.',
      flags:
        MessageFlags.Ephemeral,
    });

    return true;
  }

  const message =
    await interaction.channel.messages
      .fetch(
        messageId,
      )
      .catch(
        () =>
          null,
      );

  if (!message) {
    await interaction.reply({
      content:
        'That Modo pack message no longer exists.',
      flags:
        MessageFlags.Ephemeral,
    });

    return true;
  }

  const imageEmbed =
    getImageEmbed(
      message,
    );

  if (!imageEmbed) {
    await interaction.reply({
      content:
        'I could not find the pack image on that message.',
      flags:
        MessageFlags.Ephemeral,
    });

    return true;
  }

  const existingStatusEmbed =
    message.embeds?.[1] ||
    null;

  const entries =
    parseModoPackEntries(
      existingStatusEmbed,
    );

  const displayName =
    sanitizeModoPackDisplayName(
      interaction.member?.displayName ||
      interaction.user.globalName ||
      interaction.user.username,
    );

  const existingIndex =
    entries.findIndex(
      (entry) =>
        String(
          entry.userId,
        ) ===
        String(
          interaction.user.id,
        ),
    );

  const nextEntry = {
    userId:
      interaction.user.id,
    displayName,
    packName:
      parsed.packName,
  };

  if (
    existingIndex >=
      0
  ) {
    entries[
      existingIndex
    ] =
      nextEntry;
  } else {
    entries.push(
      nextEntry,
    );
  }

  const statusEmbed =
    new EmbedBuilder()
      .setColor(
        0x57f287,
      )
      .setDescription(
        buildModoPackListDescription(
          entries,
        ),
      )
      .setFooter({
        text:
          encodeModoPackEntries(
            entries,
          ),
      });

  await message.edit({
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

  await interaction.reply({
    content:
      `✅ Submitted **${parsed.packName}**.`,
    flags:
      MessageFlags.Ephemeral,
  });

  return true;
}

function isModoPackInteraction(
  interaction,
) {
  const customId =
    String(
      interaction?.customId ||
      '',
    );

  return (
    customId ===
      SUBMIT_BUTTON_ID ||
    customId.startsWith(
      `${MODAL_ID}:`,
    )
  );
}

async function handleModoPackInteraction(
  interaction,
) {
  if (!isModoPackInteraction(interaction)) {
    return false;
  }

  if (
    interaction.isButton() &&
    interaction.customId ===
      SUBMIT_BUTTON_ID
  ) {
    return openPackModal(
      interaction,
    );
  }

  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith(
      `${MODAL_ID}:`,
    )
  ) {
    return submitPackModal(
      interaction,
    );
  }

  return false;
}

module.exports = {
  MIN_PACK_NUMBER,
  MAX_PACK_NUMBER,
  buildModoPackComponents,
  handleModoPackInteraction,
  isModoPackInteraction,
  parseValidPackName,
};
