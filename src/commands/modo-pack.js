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

    await interaction.reply({
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
  },
};
