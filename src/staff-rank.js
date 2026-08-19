const sharp = require('sharp');
const {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { getStaffSnapshot } = require('./staff-tracking-store');
const { getStaffTrackingSettings } = require('./staff-settings-store');

const WARNING_ROLE_IDS = Object.freeze([
  '961199921841713162',
  '961199596212744252',
]);

const STAR_MANAGEMENT_ROLES = Object.freeze({
  oneStar: '955029841793650688',
  twoStar: '955030166797713408',
});

const PERIOD_LABELS = Object.freeze({
  lifetime: 'LIFETIME',
  weekly: 'WEEKLY • 7 DAYS',
  monthly: 'MONTHLY • 30 DAYS',
  quarterly: 'QUARTERLY • 90 DAYS',
});

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function safeCardText(value, fallback = '') {
  // Discord display names can contain Mathematical Unicode alphabets and emoji.
  // librsvg/Sharp may render those as hex-code boxes when the host does not
  // have the matching glyph font. NFKC converts most styled alphabets back to
  // normal letters, then we remove emoji/symbol-only characters that are not
  // reliable in server-side SVG fonts.
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')
    .replace(/[^\p{L}\p{N}\s._\-()[\]{}'!@#$%&+,:;?]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || String(fallback || '').normalize('NFKC').trim();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getStarLevel(member) {
  if (member.roles.cache.has(STAR_MANAGEMENT_ROLES.twoStar)) return 2;
  if (member.roles.cache.has(STAR_MANAGEMENT_ROLES.oneStar)) return 1;
  return 0;
}

function getWarningCount(member) {
  return WARNING_ROLE_IDS.filter((roleId) =>
    member.roles.cache.has(roleId),
  ).length;
}

function getXpState(tickets, messages, pointSettings) {
  // Performance XP uses the same owner-editable weighting as Activity Score.
  const totalXp =
    tickets * pointSettings.ticketClaimPoints +
    messages * pointSettings.trackedMessagePoints;

  let level = 1;
  let remaining = totalXp;
  let required = 500;

  while (remaining >= required && level < 999) {
    remaining -= required;
    level += 1;
    required = 500 + (level - 1) * 150;
  }

  return {
    totalXp,
    level,
    currentXp: remaining,
    requiredXp: required,
    progress: required > 0 ? clamp(remaining / required, 0, 1) : 1,
  };
}

async function fetchAvatarPng(member) {
  try {
    const response = await fetch(
      member.user.displayAvatarURL({
        extension: 'png',
        size: 256,
        forceStatic: true,
      }),
    );

    if (!response.ok) throw new Error(`Avatar HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    return await sharp(buffer)
      .resize(150, 150, { fit: 'cover' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('[RANK CARD AVATAR ERROR]', error);

    const fallback = Buffer.from(`
      <svg width="150" height="150" xmlns="http://www.w3.org/2000/svg">
        <rect width="150" height="150" rx="75" fill="#343944"/>
        <circle cx="75" cy="58" r="28" fill="#717784"/>
        <path d="M30 135c8-33 29-47 45-47s37 14 45 47" fill="#717784"/>
      </svg>
    `);

    return sharp(fallback).png().toBuffer();
  }
}

async function getRankRows(guild, snapshot, hiddenStaffUserIds = []) {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[RANK CARD MEMBER FETCH ERROR]', error);
  }

  const hidden = new Set(
    (hiddenStaffUserIds || []).map(String),
  );

  return [...guild.members.cache.values()]
    .filter(
      (member) =>
        !member.user.bot &&
        member.permissions.has(PermissionFlagsBits.ViewAuditLog) &&
        !hidden.has(member.id),
    )
    .map((member) => ({
      member,
      tickets: snapshot.claimCounts.get(member.id) || 0,
      messages: snapshot.messageCounts.get(member.id) || 0,
    }))
    .sort((a, b) => {
      if (b.tickets !== a.tickets) return b.tickets - a.tickets;
      if (b.messages !== a.messages) return b.messages - a.messages;

      return (a.member.displayName || a.member.user.username).localeCompare(
        b.member.displayName || b.member.user.username,
        undefined,
        { sensitivity: 'base' },
      );
    });
}

async function renderRankCard(guild, member, periodKey) {
  const [snapshot, pointSettings] = await Promise.all([
    getStaffSnapshot(guild.id, periodKey),
    getStaffTrackingSettings(guild.id),
  ]);
  const hiddenStaffIds = new Set(
    pointSettings.hiddenStaffUserIds || [],
  );
  const isRankHidden = hiddenStaffIds.has(member.id);
  const rows = await getRankRows(
    guild,
    snapshot,
    pointSettings.hiddenStaffUserIds,
  );

  const rankIndex = rows.findIndex((row) => row.member.id === member.id);
  const tickets = snapshot.claimCounts.get(member.id) || 0;
  const messages = snapshot.messageCounts.get(member.id) || 0;
  const rank = !isRankHidden && rankIndex >= 0 ? rankIndex + 1 : null;
  const xp = getXpState(tickets, messages, pointSettings);
  const starLevel = getStarLevel(member);
  const warningCount = getWarningCount(member);

  const avatarPng = await fetchAvatarPng(member);
  const avatarData = `data:image/png;base64,${avatarPng.toString('base64')}`;

  const rawDisplayName =
    member.displayName || member.user.globalName || member.user.username;
  const displayName = escapeXml(
    safeCardText(rawDisplayName, member.user.username).slice(0, 26),
  );
  const username = escapeXml(
    `@${safeCardText(member.user.username, member.user.id).slice(0, 30)}`,
  );
  const period = escapeXml(PERIOD_LABELS[periodKey] || PERIOD_LABELS.lifetime);

  const starText =
    starLevel === 2
      ? '2-STAR MANAGEMENT'
      : starLevel === 1
        ? '1-STAR MANAGEMENT'
        : 'STAFF';
  const warningText =
    warningCount > 0
      ? `${warningCount} WARNING ROLE${warningCount === 1 ? '' : 'S'}`
      : 'NO WARNING ROLES';

  const progressWidth = Math.max(
    xp.progress > 0 ? 4 : 0,
    Math.round(650 * xp.progress),
  );
  const progressPercent = Math.round(xp.progress * 100);
  const score =
    tickets * pointSettings.ticketClaimPoints +
    messages * pointSettings.trackedMessagePoints;

  const svg = `
  <svg width="1200" height="430" viewBox="0 0 1200 430"
       xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#171a21"/>
        <stop offset="0.55" stop-color="#20242c"/>
        <stop offset="1" stop-color="#151821"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#56e0d2"/>
        <stop offset="1" stop-color="#7f75ff"/>
      </linearGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#48d8c9"/>
        <stop offset="0.55" stop-color="#6f8fff"/>
        <stop offset="1" stop-color="#9d68ff"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="10" stdDeviation="16" flood-opacity=".32"/>
      </filter>
      <clipPath id="avatarClip">
        <circle cx="125" cy="128" r="75"/>
      </clipPath>
      <clipPath id="levelBarClip">
        <rect x="235" y="200" width="650" height="40" rx="20"/>
      </clipPath>
    </defs>

    <rect x="15" y="15" width="1170" height="400" rx="38"
          fill="url(#bg)" filter="url(#shadow)"/>
    <path d="M1005 15H1147c21 0 38 17 38 38v324c0 21-17 38-38 38H1055L925 15z"
          fill="url(#accent)" opacity=".92"/>
    <path d="M992 15L1120 415" stroke="#ffffff" stroke-opacity=".08" stroke-width="2"/>

    <circle cx="125" cy="128" r="84" fill="#11141a" stroke="url(#accent)" stroke-width="5"/>
    <image href="${avatarData}" x="50" y="53" width="150" height="150"
           preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>

    <text x="235" y="86" font-family="Arial, Helvetica, sans-serif"
          font-size="39" font-weight="700" fill="#ffffff">${displayName}</text>
    <text x="238" y="123" font-family="Arial, Helvetica, sans-serif"
          font-size="22" fill="#aeb5c2">${username}</text>

    <rect x="700" y="48" width="185" height="46" rx="23"
          fill="#2b303a" stroke="#444b59"/>
    <text x="792" y="78" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-size="17"
          font-weight="700" fill="#cfd5df">${period}</text>

    <text x="235" y="172" font-family="Arial, Helvetica, sans-serif"
          font-size="27" font-weight="700" fill="#f2f4f8">
      LEVEL ${xp.level}
    </text>
    <text x="405" y="172" font-family="Arial, Helvetica, sans-serif"
          font-size="25" fill="#c9ced7">
      XP ${xp.currentXp.toLocaleString()} / ${xp.requiredXp.toLocaleString()}
    </text>
    <text x="710" y="172" font-family="Arial, Helvetica, sans-serif"
          font-size="27" font-weight="700" fill="#f2f4f8">
      ${isRankHidden ? 'RANK HIDDEN' : `RANK #${rank}`}
    </text>

    <text x="885" y="190" text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="13" font-weight="700" fill="#aeb5c2">
      ${progressPercent}% TO NEXT LEVEL
    </text>

    <rect x="235" y="200" width="650" height="40" rx="20"
          fill="#0d1016" stroke="#414856" stroke-width="2"/>
    <g clip-path="url(#levelBarClip)">
      <rect x="235" y="200" width="${progressWidth}" height="40"
            fill="url(#bar)"/>
      <rect x="235" y="200" width="${progressWidth}" height="10"
            fill="#ffffff" opacity=".10"/>
    </g>
    <rect x="235" y="200" width="650" height="40" rx="20"
          fill="none" stroke="#ffffff" stroke-opacity=".14"/>

    <rect x="320" y="274" width="176" height="94" rx="20" fill="#292e38"/>
    <rect x="512" y="274" width="176" height="94" rx="20" fill="#292e38"/>
    <rect x="704" y="274" width="176" height="94" rx="20" fill="#292e38"/>

    <text x="340" y="307" font-family="Arial, Helvetica, sans-serif"
          font-size="12.5" font-weight="700" fill="#8e96a5">TICKETS CLAIMED</text>
    <text x="340" y="350" font-family="Arial, Helvetica, sans-serif"
          font-size="34" font-weight="700" fill="#ffffff">${tickets.toLocaleString()}</text>

    <text x="532" y="307" font-family="Arial, Helvetica, sans-serif"
          font-size="12.5" font-weight="700" fill="#8e96a5">TRACKED MESSAGES</text>
    <text x="532" y="350" font-family="Arial, Helvetica, sans-serif"
          font-size="34" font-weight="700" fill="#ffffff">${messages.toLocaleString()}</text>

    <text x="724" y="307" font-family="Arial, Helvetica, sans-serif"
          font-size="12.5" font-weight="700" fill="#8e96a5">ACTIVITY SCORE</text>
    <text x="724" y="350" font-family="Arial, Helvetica, sans-serif"
          font-size="34" font-weight="700" fill="#ffffff">${score.toLocaleString()}</text>

    ${
      starLevel > 0
        ? `
          <polygon points="62,246 66,256 77,257 68,264 71,275 62,269 53,275 56,264 47,257 58,256"
                   fill="#f7c948"/>
          ${
            starLevel === 2
              ? `<polygon points="84,246 88,256 99,257 90,264 93,275 84,269 75,275 78,264 69,257 80,256"
                          fill="#f7c948"/>`
              : ''
          }
        `
        : `
          <circle cx="63" cy="260" r="9" fill="#64dfd2" opacity=".9"/>
        `
    }
    <text x="108" y="266"
          font-family="Arial, Helvetica, sans-serif"
          font-size="13.5" font-weight="700" fill="#64dfd2">${escapeXml(starText)}</text>

    ${
      warningCount > 0
        ? `
          <polygon points="63,286 75,308 51,308"
                   fill="#ffb65c"/>
          <rect x="62" y="293" width="2" height="8" rx="1" fill="#171a21"/>
          <circle cx="63" cy="304.5" r="1.5" fill="#171a21"/>
        `
        : `
          <circle cx="63" cy="298" r="11" fill="#79dda6"/>
          <path d="M57 298l4 4 8-9" fill="none" stroke="#17221c"
                stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        `
    }
    <text x="108" y="304" font-family="Arial, Helvetica, sans-serif"
          font-size="13.5" font-weight="700"
          fill="${warningCount ? '#ffb65c' : '#79dda6'}">${escapeXml(warningText)}</text>

    <text x="60" y="348" font-family="Arial, Helvetica, sans-serif"
          font-size="13" fill="#737b89">PERFORMANCE XP</text>
    <text x="60" y="377" font-family="Arial, Helvetica, sans-serif"
          font-size="18" font-weight="700" fill="#cbd1da">${xp.totalXp.toLocaleString()} TOTAL XP</text>
    <text x="885" y="393" text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="11" fill="#747d8b">
      ${pointSettings.ticketClaimPoints} PTS/TICKET • ${pointSettings.trackedMessagePoints} PTS/MESSAGE
    </text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function sendRankCard(
  interaction,
  periodKey = 'lifetime',
) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Use this command inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requester = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (
    !requester ||
    !requester.permissions.has(PermissionFlagsBits.ViewAuditLog)
  ) {
    await interaction.reply({
      content: 'This command is available to staff with **View Audit Log** permission.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Read the selected target directly from the slash-command interaction.
  // This avoids any argument-order/version mismatch between command files and
  // the rank-card helper.
  const selectedUser = interaction.options?.getUser('staff') || null;
  const targetId = selectedUser?.id || interaction.user.id;

  console.log(
    `[RANK] Requested by ${interaction.user.id}; target=${targetId}; ` +
      `period=${periodKey}`,
  );

  const member = await interaction.guild.members
    .fetch(targetId)
    .catch(() => null);

  if (
    !member ||
    member.user.bot ||
    !member.permissions.has(PermissionFlagsBits.ViewAuditLog)
  ) {
    await interaction.reply({
      content: `This user isn't Snay.io staff.`,
      allowedMentions: { parse: [] },
    });

    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 3000);

    return;
  }

  await interaction.deferReply();

  try {
    const card = await renderRankCard(
      interaction.guild,
      member,
      periodKey,
    );

    console.log(
      `[RANK] Generated card for ${member.user.tag} (${member.id}) ` +
        `requested by ${interaction.user.tag} (${interaction.user.id}).`,
    );

    await interaction.editReply({
      files: [
        new AttachmentBuilder(card, {
          name: `staff-rank-${member.id}-${periodKey}.png`,
        }),
      ],
    });
  } catch (error) {
    console.error('[RANK CARD ERROR]', error);

    await interaction.editReply({
      content: 'I could not generate your staff rank card.',
    });
  }
}

module.exports = {
  sendRankCard,
  renderRankCard,
};
