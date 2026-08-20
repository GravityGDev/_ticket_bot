const { gunzipSync } = require('node:zlib');
const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  verifyTranscriptHtml,
} = require('../transcript-integrity');

const MAX_TRANSCRIPT_BYTES =
  100 * 1024 * 1024;

function passFail(value) {
  return value
    ? '✅ Pass'
    : '❌ Fail';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify-transcript')
    .setDescription(
      'Verify a Snay ticket transcript has not been modified.',
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator,
    )
    .addAttachmentOption(
      (option) =>
        option
          .setName(
            'transcript',
          )
          .setDescription(
            'The Snay ticket transcript (.html or .html.gz).',
          )
          .setRequired(
            true,
          ),
    ),

  async execute(
    interaction,
  ) {
    if (
      !interaction.inGuild()
    ) {
      await interaction.reply({
        content:
          'Use this command inside a server.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }

    const member =
      await interaction.guild.members
        .fetch(
          interaction.user.id,
        )
        .catch(
          () => null,
        );

    if (
      !member ||
      !member.permissions.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content:
          'You need **Administrator** permission to use `/verify-transcript`.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }

    const attachment =
      interaction.options.getAttachment(
        'transcript',
        true,
      );

    const filename =
      String(
        attachment.name || '',
      );

    if (
      !/\.html?(?:\.gz)?$/i.test(
        filename,
      )
    ) {
      await interaction.reply({
        content:
          'Please upload the original `.html` or `.html.gz` ticket transcript.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }

    if (
      Number(
        attachment.size,
      ) >
      MAX_TRANSCRIPT_BYTES
    ) {
      await interaction.reply({
        content:
          'That transcript is too large to verify in memory.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({
      flags:
        MessageFlags.Ephemeral,
    });

    try {
      const response =
        await fetch(
          attachment.url,
          {
            redirect:
              'follow',
            headers: {
              'User-Agent':
                'Snay-Transcript-Verifier/1.0',
            },
          },
        );

      if (!response.ok) {
        throw new Error(
          `Discord returned HTTP ${response.status}.`,
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer(),
        );

      if (
        buffer.length >
        MAX_TRANSCRIPT_BYTES
      ) {
        throw new Error(
          'Transcript exceeds the verifier size limit.',
        );
      }

      const transcriptBuffer =
        /\.gz$/i.test(filename)
          ? gunzipSync(buffer)
          : buffer;

      const result =
        await verifyTranscriptHtml(
          transcriptBuffer.toString(
            'utf8',
          ),
        );

      if (!result.parsed) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(
                0xed4245,
              )
              .setTitle(
                '❌ Not a Signed Snay Transcript',
              )
              .setDescription(
                result.reason,
              )
              .setFooter({
                text:
                  'No valid Snay transcript integrity block was found.',
              })
              .setTimestamp(),
          ],
        });
        return;
      }

      const record =
        result.databaseRecord;

      const metadata =
        record?.metadata || {};

      const embed =
        new EmbedBuilder()
          .setColor(
            result.valid
              ? 0x57f287
              : 0xed4245,
          )
          .setTitle(
            result.valid
              ? '✅ Transcript Verified'
              : '❌ Transcript Integrity Failed',
          )
          .setDescription(
            result.valid
              ? 'The uploaded transcript exactly matches the cryptographically signed Snay.io record.'
              : 'The uploaded transcript did **not** pass every integrity check. Treat it as modified, invalid, or unverifiable.',
          )
          .addFields(
            {
              name:
                'Transcript ID',
              value:
                String(
                  result.transcriptId,
                ),
            },
            {
              name:
                'Ticket',
              value:
                metadata.ticketNumber !==
                undefined
                  ? `#${metadata.ticketNumber}`
                  : 'Unknown',
              inline:
                true,
            },
            {
              name:
                'Ticket Type',
              value:
                metadata.ticketTypeLabel ||
                metadata.ticketType ||
                'Unknown',
              inline:
                true,
            },
            {
              name:
                'Content SHA-256',
              value:
                passFail(
                  result.checks.contentHash,
                ),
              inline:
                true,
            },
            {
              name:
                'HMAC Signature',
              value:
                passFail(
                  result.checks.hmac,
                ),
              inline:
                true,
            },
            {
              name:
                'MongoDB Record',
              value:
                passFail(
                  result.checks.databaseRecord,
                ),
              inline:
                true,
            },
            {
              name:
                'Stored Hash Match',
              value:
                passFail(
                  result.checks.databaseHash,
                ),
              inline:
                true,
            },
            {
              name:
                'Stored Signature Match',
              value:
                passFail(
                  result.checks.databaseSignature,
                ),
              inline:
                true,
            },
            {
              name:
                'SHA-256',
              value:
                String(
                  result.embeddedSha256,
                ),
            },
          )
          .setTimestamp();

      if (
        record?.generatedAt
      ) {
        embed.addFields({
          name:
            'Originally Generated',
          value:
            `<t:${Math.floor(
              new Date(
                record.generatedAt,
              ).getTime() /
                1000,
            )}:F>`,
        });
      }

      await interaction.editReply({
        embeds: [
          embed,
        ],
      });
    } catch (error) {
      console.error(
        '[VERIFY TRANSCRIPT ERROR]',
        error,
      );

      await interaction.editReply({
        content:
          `I could not verify that transcript: ${
            error?.message ||
            'Unknown error'
          }`,
      });
    }
  },
};
