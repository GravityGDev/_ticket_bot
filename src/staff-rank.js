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
  weekly: 'WEEKLY • LAST 7 DAYS',
  monthly: 'MONTHLY • LAST 30 DAYS',
  quarterly: 'QUARTERLY • LAST 90 DAYS',
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
  return WARNING_ROLE_IDS.filter((roleId) => member.roles.cache.has(roleId)).length;
}

function getXpState(tickets, messages, pointSettings) {
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
        size: 512,
        forceStatic: true,
      }),
    );

    if (!response.ok) throw new Error(`Avatar HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    return await sharp(buffer)
      .resize(220, 220, { fit: 'cover' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('[RANK CARD AVATAR ERROR]', error);

    const fallback = Buffer.from(`
      <svg width="220" height="220" xmlns="http://www.w3.org/2000/svg">
        <rect width="220" height="220" rx="110" fill="#343944"/>
        <circle cx="110" cy="86" r="40" fill="#717784"/>
        <path d="M46 194c12-49 42-69 64-69s52 20 64 69" fill="#717784"/>
      </svg>
    `);

    return sharp(fallback).png().toBuffer();
  }
}

async function getRankRows(guild, snapshot) {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[RANK CARD MEMBER FETCH ERROR]', error);
  }

  return [...guild.members.cache.values()]
    .filter(
      (member) =>
        !member.user.bot &&
        member.permissions.has(PermissionFlagsBits.ViewAuditLog),
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

function buildStarMarkup(starLevel) {
  if (starLevel === 2) {
    return `
      <polygon points="118,480 126,500 148,502 131,516 137,538 118,526 99,538 105,516 88,502 110,500" fill="#f7c948"/>
      <polygon points="160,480 168,500 190,502 173,516 179,538 160,526 141,538 147,516 130,502 152,500" fill="#f7c948"/>
    `;
  }

  if (starLevel === 1) {
    return `
      <polygon points="118,480 126,500 148,502 131,516 137,538 118,526 99,538 105,516 88,502 110,500" fill="#f7c948"/>
    `;
  }

  return `<circle cx="118" cy="510" r="16" fill="#64dfd2" opacity=".95"/>`;
}

function buildWarningMarkup(warningCount) {
  if (warningCount > 0) {
    return `
      <polygon points="118,560 138,594 98,594" fill="#ffb65c"/>
      <rect x="116" y="570" width="4" height="13" rx="2" fill="#171a21"/>
      <circle cx="118" cy="588" r="2.5" fill="#171a21"/>
    `;
  }

  return `
    <circle cx="118" cy="577" r="20" fill="#79dda6"/>
    <path d="M105 577l8 8 16-18" fill="none" stroke="#17221c"
      stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

async function renderRankCard(guild, member, periodKey) {
  const [snapshot, pointSettings] = await Promise.all([
    getStaffSnapshot(guild.id, periodKey),
    getStaffTrackingSettings(guild.id),
  ]);
  const rows = await getRankRows(guild, snapshot);

  const rankIndex = rows.findIndex((row) => row.member.id === member.id);
  const tickets = snapshot.claimCounts.get(member.id) || 0;
  const messages = snapshot.messageCounts.get(member.id) || 0;
  const rank = rankIndex >= 0 ? rankIndex + 1 : rows.length + 1;
  const xp = getXpState(tickets, messages, pointSettings);
  const starLevel = getStarLevel(member);
  const warningCount = getWarningCount(member);
  const score =
    tickets * pointSettings.ticketClaimPoints +
    messages * pointSettings.trackedMessagePoints;

  const avatarPng = await fetchAvatarPng(member);
  const avatarData = `data:image/png;base64,${avatarPng.toString('base64')}`;

  const rawDisplayName =
    member.displayName || member.user.globalName || member.user.username;
  const displayName = escapeXml(
    safeCardText(rawDisplayName, member.user.username).slice(0, 28),
  );
  const username = escapeXml(
    `@${safeCardText(member.user.username, member.user.id).slice(0, 32)}`,
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

  const progressPercent = Math.round(xp.progress * 100);
  const progressWidth = xp.progress > 0 ? Math.max(12, Math.round(962 * xp.progress)) : 0;

  const svg = `
  <svg width="1500" height="980" viewBox="0 0 1500 980"
       xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#141821"/>
        <stop offset="0.5" stop-color="#1a2028"/>
        <stop offset="1" stop-color="#121620"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#56e0d2"/>
        <stop offset="1" stop-color="#8075ff"/>
      </linearGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#50dccd"/>
        <stop offset="0.55" stop-color="#6e8fff"/>
        <stop offset="1" stop-color="#9a68ff"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="14" stdDeviation="18" flood-opacity=".35"/>
      </filter>
      <clipPath id="avatarClip">
        <circle cx="170" cy="174" r="110"/>
      </clipPath>
      <clipPath id="barClip">
        <rect x="300" y="310" width="962" height="54" rx="27"/>
      </clipPath>
    </defs>

    <rect x="20" y="20" width="1460" height="940" rx="46"
          fill="url(#bg)" filter="url(#shadow)"/>

    <path d="M1128 20H1434c25 0 46 21 46 46v848c0 25-21 46-46 46H1328L1082 20z"
          fill="url(#accent)" opacity=".92"/>
    <path d="M1120 20L1338 960" stroke="#ffffff" stroke-opacity=".09" stroke-width="3"/>
    <path d="M0 0" stroke="none"/>

    <circle cx="170" cy="174" r="126" fill="#10141c" stroke="url(#accent)" stroke-width="7"/>
    <image href="${avatarData}" x="60" y="64" width="220" height="220"
           preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>

    <text x="300" y="120" font-family="Arial, Helvetica, sans-serif"
          font-size="66" font-weight="700" fill="#ffffff">${displayName}</text>
    <text x="302" y="168" font-family="Arial, Helvetica, sans-serif"
          font-size="34" fill="#b3bac8">${username}</text>

    <rect x="1050" y="72" width="260" height="70" rx="35"
          fill="#2a2f39" stroke="#4b5261" stroke-width="2"/>
    <text x="1180" y="116" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-size="28"
          font-weight="700" fill="#dde3ec">${period}</text>

    <text x="300" y="248" font-family="Arial, Helvetica, sans-serif"
          font-size="56" font-weight="700" fill="#ffffff">LEVEL ${xp.level}</text>
    <text x="520" y="248" font-family="Arial, Helvetica, sans-serif"
          font-size="42" fill="#cfd5df">XP ${xp.currentXp.toLocaleString()} / ${xp.requiredXp.toLocaleString()}</text>
    <text x="1088" y="248" font-family="Arial, Helvetica, sans-serif"
          font-size="58" font-weight="700" fill="#ffffff">RANK #${rank}</text>

    <text x="1262" y="292" text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="28" font-weight="700" fill="#d2d8e2">${progressPercent}% TO NEXT LEVEL</text>

    <rect x="300" y="310" width="962" height="54" rx="27"
          fill="#0a0e16" stroke="#4a5160" stroke-width="3"/>
    <g clip-path="url(#barClip)">
      <rect x="300" y="310" width="${progressWidth}" height="54" fill="url(#bar)"/>
      <rect x="300" y="310" width="${progressWidth}" height="14" fill="#ffffff" opacity=".12"/>
    </g>
    <rect x="300" y="310" width="962" height="54" rx="27"
          fill="none" stroke="#ffffff" stroke-opacity=".14"/>

    ${buildStarMarkup(starLevel)}
    <text x="200" y="520"
          font-family="Arial, Helvetica, sans-serif"
          font-size="34" font-weight="700" fill="#64dfd2">${escapeXml(starText)}</text>

    ${buildWarningMarkup(warningCount)}
    <text x="200" y="588" font-family="Arial, Helvetica, sans-serif"
          font-size="34" font-weight="700"
          fill="${warningCount ? '#ffb65c' : '#79dda6'}">${escapeXml(warningText)}</text>

    <text x="86" y="720" font-family="Arial, Helvetica, sans-serif"
          font-size="28" fill="#7f8796">PERFORMANCE XP</text>
    <text x="86" y="770" font-family="Arial, Helvetica, sans-serif"
          font-size="52" font-weight="700" fill="#ffffff">${xp.totalXp.toLocaleString()} TOTAL XP</text>

    <rect x="420" y="500" width="280" height="190" rx="28" fill="#2a2f3a"/>
    <rect x="740" y="500" width="280" height="190" rx="28" fill="#2a2f3a"/>
    <rect x="1060" y="500" width="280" height="190" rx="28" fill="#2a2f3a"/>

    <text x="454" y="560" font-family="Arial, Helvetica, sans-serif"
          font-size="24" font-weight="700" fill="#98a1af">TICKETS CLAIMED</text>
    <text x="454" y="640" font-family="Arial, Helvetica, sans-serif"
          font-size="74" font-weight="700" fill="#ffffff">${tickets.toLocaleString()}</text>

    <text x="774" y="560" font-family="Arial, Helvetica, sans-serif"
          font-size="24" font-weight="700" fill="#98a1af">TRACKED MESSAGES</text>
    <text x="774" y="640" font-family="Arial, Helvetica, sans-serif"
          font-size="74" font-weight="700" fill="#ffffff">${messages.toLocaleString()}</text>

    <text x="1094" y="560" font-family="Arial, Helvetica, sans-serif"
          font-size="24" font-weight="700" fill="#98a1af">ACTIVITY SCORE</text>
    <text x="1094" y="640" font-family="Arial, Helvetica, sans-serif"
          font-size="74" font-weight="700" fill="#ffffff">${score.toLocaleString()}</text>

    <rect x="420" y="735" width="920" height="130" rx="26" fill="#1f2530" stroke="#313846"/>
    <text x="460" y="795" font-family="Arial, Helvetica, sans-serif"
          font-size="28" font-weight="700" fill="#cfd6df">SCORING MODEL</text>
    <text x="460" y="842" font-family="Arial, Helvetica, sans-serif"
          font-size="30" fill="#aeb6c4">${pointSettings.ticketClaimPoints} point${pointSettings.ticketClaimPoints === 1 ? '' : 's'} per ticket claim • ${pointSettings.trackedMessagePoints} point${pointSettings.trackedMessagePoints === 1 ? '' : 's'} per tracked message</text>

    <text x="1340" y="928" text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="22" fill="#8992a1">Snay.io Staff Rank Poster</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function sendRankCard(
  interaction,
  periodKey = 'lifetime',
  targetUser = null,
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

  if (!requester || !requester.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    await interaction.reply({
      content: 'This command is available to staff with **View Audit Log** permission.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetId = targetUser?.id || interaction.user.id;
  const member = await interaction.guild.members
    .fetch(targetId)
    .catch(() => null);

  if (
    !member ||
    member.user.bot ||
    !member.permissions.has(PermissionFlagsBits.ViewAuditLog)
  ) {
    await interaction.reply({
      content: 'That user is not a tracked staff member with **View Audit Log** permission.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const card = await renderRankCard(interaction.guild, member, periodKey);

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
