const {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  createWarningRemovalSchedule,
  attachWarningMessage,
  getStaffWarningHistoryCount,
} = require('../staff-settings-store');
const {
  buildWarningActionRow,
} = require('../warn-system');

const WARNING_ROLES = Object.freeze({
  warning1: '961199921841713162',
  warning2: '961199596212744252',
});

const REMOVE_DURATIONS = Object.freeze({
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

const MONTHS = Object.freeze([
  ['January', 1],
  ['February', 2],
  ['March', 3],
  ['April', 4],
  ['May', 5],
  ['June', 6],
  ['July', 7],
  ['August', 8],
  ['September', 9],
  ['October', 10],
  ['November', 11],
  ['December', 12],
]);

function buildYearChoices() {
  // Discord allows at most 25 fixed choices. This gives a selectable year
  // dropdown from 2026 through 2050 inclusive.
  return Array.from({ length: 25 }, (_, index) => {
    const year = 2026 + index;
    return {
      name: String(year),
      value: year,
    };
  });
}


function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function makeLondonLocalDate(year, month, day, hour, minute) {
  const maxDay = daysInMonth(year, month);

  if (day > maxDay) {
    throw new Error(
      `${MONTHS[month - 1]?.[0] || 'That month'} ${year} only has ${maxDay} days.`,
    );
  }

  // Convert a Europe/London wall-clock time into UTC without another package.
  // We test both standard-time and BST candidates and keep whichever formats
  // back to the requested London local components.
  const requested = {
    year,
    month,
    day,
    hour,
    minute,
  };

  const formatParts = (date) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );

    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  };

  const matches = (parts) =>
    parts.year === requested.year &&
    parts.month === requested.month &&
    parts.day === requested.day &&
    parts.hour === requested.hour &&
    parts.minute === requested.minute;

  // Candidate assuming GMT.
  const gmtCandidate = new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0),
  );

  // Candidate assuming BST (+01:00), so UTC is one hour earlier.
  const bstCandidate = new Date(
    Date.UTC(year, month - 1, day, hour - 1, minute, 0, 0),
  );

  if (matches(formatParts(gmtCandidate))) return gmtCandidate;
  if (matches(formatParts(bstCandidate))) return bstCandidate;

  throw new Error(
    'That UK date/time does not exist because of the daylight-saving clock change. Choose another time.',
  );
}

function getLondonDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function getRemovalDate(interaction, duration) {
  if (duration !== 'custom') {
    const milliseconds = REMOVE_DURATIONS[duration];

    if (!milliseconds) {
      throw new Error('Invalid warning removal duration.');
    }

    return new Date(Date.now() + milliseconds);
  }

  // Use London time because the server's Render timezone may be UTC.
  const nowParts = getLondonDateParts(new Date());
  const fiveMinutesFromNowParts = getLondonDateParts(
    new Date(Date.now() + 5 * 60 * 1000),
  );

  const selectedYear = interaction.options.getInteger('year');
  const selectedMonth = interaction.options.getInteger('month');
  const selectedDay = interaction.options.getInteger('day');
  const selectedHour = interaction.options.getInteger('hour');
  const selectedMinute = interaction.options.getInteger('minute');

  // Blank custom fields inherit the current UK date/time.
  //
  // Minute is special: when omitted it uses the minute from 5 minutes in the
  // future. If hour/day/month/year are also omitted, their values come from
  // that same +5 minute timestamp so rollover at 23:58, month-end, New Year,
  // etc. works correctly.
  const minuteWasOmitted = selectedMinute === null;

  const fallbackParts = minuteWasOmitted
    ? fiveMinutesFromNowParts
    : nowParts;

  const year = selectedYear ?? fallbackParts.year;
  const month = selectedMonth ?? fallbackParts.month;
  const day = selectedDay ?? fallbackParts.day;
  const hour = selectedHour ?? fallbackParts.hour;
  const minute = selectedMinute ?? fiveMinutesFromNowParts.minute;

  return makeLondonLocalDate(
    year,
    month,
    day,
    hour,
    minute,
  );
}

function getEvidenceAttachments(interaction) {
  const attachments = [];

  for (let index = 1; index <= 5; index += 1) {
    const attachment = interaction.options.getAttachment(
      `evidence-${index}`,
    );

    if (!attachment) continue;

    const contentType = String(attachment.contentType || '').toLowerCase();
    const fileName = String(attachment.name || '').toLowerCase();
    const imageExtension = /\.(png|jpe?g|gif|webp)$/i.test(fileName);

    if (!contentType.startsWith('image/') && !imageExtension) {
      throw new Error(
        `Evidence ${index} must be an image (PNG, JPG, GIF or WEBP).`,
      );
    }

    attachments.push(attachment);
  }

  return attachments;
}

async function downloadEvidenceFiles(attachments) {
  const files = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const response = await fetch(attachment.url);

    if (!response.ok) {
      throw new Error(
        `I could not download evidence image ${index + 1}.`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Keep filenames deterministic and attachment:// safe.
    const originalName = String(
      attachment.name || `evidence-${index + 1}.png`,
    );
    const extensionMatch = originalName.match(/\.[A-Za-z0-9]{2,5}$/);
    const extension = extensionMatch
      ? extensionMatch[0].toLowerCase()
      : '.png';

    files.push({
      attachment: buffer,
      name: `warning-evidence-${index + 1}${extension}`,
      contentType: attachment.contentType || null,
      originalName,
    });
  }

  return files;
}


const {
  isStaffMember,
} = require('../staff-role-hierarchy');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a staff member and schedule automatic role removal.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option
        .setName('staff')
        .setDescription('Staff member to warn.')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the warning.')
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addStringOption((option) =>
      option
        .setName('warning-role')
        .setDescription('Which warning role to give.')
        .setRequired(true)
        .addChoices(
          {
            name: 'Warning 1',
            value: WARNING_ROLES.warning1,
          },
          {
            name: 'Warning 2',
            value: WARNING_ROLES.warning2,
          },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('remove-in')
        .setDescription('When the warning should automatically be removed.')
        .setRequired(true)
        .addChoices(
          { name: '30 minutes', value: '30m' },
          { name: '1 hour', value: '1h' },
          { name: '6 hours', value: '6h' },
          { name: '12 hours', value: '12h' },
          { name: '1 day', value: '1d' },
          { name: '3 days', value: '3d' },
          { name: '7 days', value: '7d' },
          { name: '14 days', value: '14d' },
          { name: '30 days', value: '30d' },
          { name: 'Custom date/time', value: 'custom' },
        ),
    )
    .addAttachmentOption((option) =>
      option
        .setName('evidence-1')
        .setDescription('Required evidence image.')
        .setRequired(true),
    )
    .addAttachmentOption((option) =>
      option
        .setName('evidence-2')
        .setDescription('Optional evidence image 2.')
        .setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName('evidence-3')
        .setDescription('Optional evidence image 3.')
        .setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName('evidence-4')
        .setDescription('Optional evidence image 4.')
        .setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName('evidence-5')
        .setDescription('Optional evidence image 5.')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('year')
        .setDescription('Custom only: year. Blank = current UK year.')
        .setRequired(false)
        .addChoices(...buildYearChoices()),
    )
    .addIntegerOption((option) =>
      option
        .setName('month')
        .setDescription('Custom only: month. Blank = current UK month.')
        .setRequired(false)
        .addChoices(
          ...MONTHS.map(([name, value]) => ({ name, value })),
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('day')
        .setDescription('Custom only: day (1-31). Blank = current UK day.')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(31),
    )
    .addIntegerOption((option) =>
      option
        .setName('hour')
        .setDescription('Custom only: hour 0-23. Blank = current UK hour.')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(23),
    )
    .addIntegerOption((option) =>
      option
        .setName('minute')
        .setDescription('Custom only: minute 0-59. Blank = 5 minutes from now.')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(59),
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requester =
      await interaction.guild.members
        .fetch(
          interaction.user.id,
        )
        .catch(() => null);

    if (
      !requester?.permissions.has(
        PermissionFlagsBits.Administrator,
      )
    ) {
      await interaction.reply({
        content: 'You need **Administrator** permission to use `/warn`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    try {
      const targetUser = interaction.options.getUser('staff', true);
      const reason = interaction.options.getString('reason', true).trim();
      const roleId = interaction.options.getString('warning-role', true);
      const duration = interaction.options.getString('remove-in', true);
      const evidenceAttachments = getEvidenceAttachments(interaction);

      const member = await interaction.guild.members
        .fetch(targetUser.id)
        .catch(() => null);

      if (!member || member.user.bot) {
        throw new Error('The selected staff member is not available.');
      }

      if (
        !isStaffMember(
          member,
        )
      ) {
        throw new Error('This user is not Snay.io staff.');
      }

      const role =
        interaction.guild.roles.cache.get(roleId) ||
        (await interaction.guild.roles.fetch(roleId).catch(() => null));

      if (!role) {
        throw new Error('That configured warning role no longer exists.');
      }

      const botMember =
        interaction.guild.members.me ||
        (await interaction.guild.members.fetchMe());

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('The bot needs **Manage Roles**.');
      }

      if (
        role.managed ||
        role.position >= botMember.roles.highest.position
      ) {
        throw new Error(
          'The bot cannot manage that warning role. Move the bot role above it.',
        );
      }

      const executeAt = getRemovalDate(interaction, duration);

      if (executeAt.getTime() <= Date.now()) {
        throw new Error('The warning removal date/time must be in the future.');
      }

      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(
          role,
          `Staff warning by ${interaction.user.tag}: ${reason}`,
        );
      }

      const schedule = await createWarningRemovalSchedule(
        interaction.guild.id,
        {
          userId: member.id,
          roleId: role.id,
          executeAt,
          reason,
        },
        interaction.user.id,
      );

      const [
        warningCount,
        evidenceFiles,
      ] = await Promise.all([
        getStaffWarningHistoryCount(
          interaction.guild.id,
          member.id,
        ),
        downloadEvidenceFiles(evidenceAttachments),
      ]);

      const unix = Math.floor(
        new Date(schedule.executeAt).getTime() / 1000,
      );

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚠️ Staff Warning')
        .setDescription(`<@${member.id}> has received a staff warning.`)
        .addFields(
          {
            name: 'Warning Role',
            value: `<@&${role.id}>`,
            inline: true,
          },
          {
            name: 'Issued By',
            value: `<@${interaction.user.id}>`,
            inline: true,
          },
          {
            name: 'Reason',
            value: reason,
          },
          {
            name: 'Warning History',
            value:
              `**${warningCount}** warning${warningCount === 1 ? '' : 's'} on record`,
            inline: true,
          },
          {
            name: 'Automatic Removal',
            value: `<t:${unix}:F>`,
          },
        )
        .setFooter({
          text: 'The warning will be removed automatically at the time above.',
        })
        .setTimestamp();

      // Send only the embed; there is no separate ping/message above it.
      // Mentions inside the embed are displayed without generating notifications.
      // Send the warning embed by itself first.
      //
      // Evidence is sent as the next grouped bot message. This prevents Discord
      // from showing the same image once as a raw attachment above the warning
      // embed and again inside an Evidence embed.
      const warningMessage = await interaction.channel.send({
        embeds: [embed],
        components: [
          buildWarningActionRow(String(schedule._id)),
        ],
        allowedMentions: {
          parse: [],
        },
      });

      const evidenceMessage = await interaction.channel.send({
        content: '**Evidence:**',
        files: evidenceFiles.map((file) => ({
          attachment: file.attachment,
          name: file.name,
        })),
        allowedMentions: {
          parse: [],
        },
      });

      const storedEvidence = [...evidenceMessage.attachments.values()]
        .map((attachment) => ({
          url: attachment.url,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          messageId: evidenceMessage.id,
          channelId: interaction.channel.id,
        }));

      // Persist the main warning message plus the evidence attachment URLs.
      // Revoke / Extend / automatic removal continue editing only the main
      // warning embed, so the evidence message underneath stays untouched.
      await attachWarningMessage(
        interaction.guild.id,
        String(schedule._id),
        interaction.channel.id,
        warningMessage.id,
        storedEvidence,
      );

      await interaction.deleteReply().catch(() => {});
    } catch (error) {
      console.error('[WARN COMMAND ERROR]', error);

      await interaction.editReply(
        `I could not create that warning: ${error?.message || 'Unknown error'}`,
      );
    }
  },
};
