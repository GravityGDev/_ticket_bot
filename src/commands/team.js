const {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const {
  STAFF_ROLE_IDS,
  getHighestStaffRoleIndex,
} = require('../staff-role-hierarchy');

function splitMemberMentions(
  members,
  maxLength = 950,
) {
  if (!members.length) {
    return ['*No staff in this role.*'];
  }

  const chunks = [];
  let current = '';

  for (const member of members) {
    const line =
      `<@${member.id}>`;

    const candidate =
      current
        ? `${current}\n${line}`
        : line;

    if (
      candidate.length >
        maxLength &&
      current
    ) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

module.exports = {
  data:
    new SlashCommandBuilder()
      .setName('team')
      .setDescription(
        'View the full Snay.io staff team from highest rank to lowest.',
      ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content:
          'Use this command inside the server.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    try {
      await interaction.guild.members.fetch();

      const groups =
        STAFF_ROLE_IDS.map(
          () => [],
        );

      for (
        const member of
        interaction.guild.members.cache.values()
      ) {
        if (member.user.bot) {
          continue;
        }

        const level =
          getHighestStaffRoleIndex(
            member,
          );

        if (level >= 0) {
          groups[level].push(
            member,
          );
        }
      }

      for (const group of groups) {
        group.sort((a, b) =>
          (
            a.displayName ||
            a.user.username
          ).localeCompare(
            b.displayName ||
            b.user.username,
            undefined,
            {
              sensitivity:
                'base',
            },
          ),
        );
      }

      const embeds = [];
      let embed =
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(
            '👥 Snay.io Staff Team',
          )
          .setDescription(
            'Highest staff role first. Members with multiple staff roles are shown only under their **highest** hierarchy role.',
          );

      let fieldCount = 0;

      for (
        let index =
          STAFF_ROLE_IDS.length - 1;
        index >= 0;
        index -= 1
      ) {
        const roleId =
          STAFF_ROLE_IDS[index];

        const role =
          interaction.guild.roles.cache.get(
            roleId,
          );

        const roleTitle =
          `Level ${index + 1} • ` +
          `${role?.name || roleId}`;

        const chunks =
          splitMemberMentions(
            groups[index],
          );

        for (
          let chunkIndex = 0;
          chunkIndex <
            chunks.length;
          chunkIndex += 1
        ) {
          if (
            fieldCount >= 24
          ) {
            embeds.push(embed);

            embed =
              new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle(
                  '👥 Snay.io Staff Team • Continued',
                );

            fieldCount = 0;
          }

          embed.addFields({
            name:
              chunkIndex === 0
                ? (
                    `${roleTitle} ` +
                    `(${groups[index].length})`
                  )
                : `${roleTitle} • continued`,
            value:
              chunks[chunkIndex],
            inline:
              false,
          });

          fieldCount += 1;
        }
      }

      embeds.push(embed);

      await interaction.editReply({
        embeds:
          embeds.slice(
            0,
            10,
          ),
        allowedMentions: {
          parse: [],
        },
      });
    } catch (error) {
      console.error(
        '[TEAM COMMAND ERROR]',
        error,
      );

      await interaction.editReply({
        content:
          'I could not build the staff team list.',
      });
    }
  },
};
