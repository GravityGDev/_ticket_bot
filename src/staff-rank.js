const {
  configureRankFonts,
} = require('./rank-font-runtime');

configureRankFonts();

const sharp = require('sharp');
const { calculateStaffActivityPoints } = require('./staff-activity-points');
const {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { getStaffSnapshot } = require('./staff-tracking-store');
const { getStaffTrackingSettings } = require('./staff-settings-store');
const {
  getStaffPointOverridesForPeriod,
} = require('./staff-point-overrides-store');
const {
  isStaffMember,
} = require('./staff-role-hierarchy');

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

function getXpState(totalXp) {
  let level = 1;
  let remaining = Math.max(0, Number(totalXp) || 0);
  let required = 500;

  while (remaining >= required && level < 999) {
    remaining -= required;
    level += 1;
    required = 500 + (level - 1) * 150;
  }

  return {
    totalXp: Math.max(0, Number(totalXp) || 0),
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
      .resize(280, 280, { fit: 'cover' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('[RANK CARD AVATAR ERROR]', error);

    const fallback = Buffer.from(`
      <svg width="280" height="280" xmlns="http://www.w3.org/2000/svg">
        <rect width="280" height="280" rx="140" fill="#343944"/>
        <circle cx="140" cy="108" r="52" fill="#717784"/>
        <path d="M56 250c15-61 52-88 84-88s69 27 84 88" fill="#717784"/>
      </svg>
    `);

    return sharp(fallback).png().toBuffer();
  }
}

async function getRankRows(
  guild,
  snapshot,
  pointSettings,
  pointOverrides,
  hiddenStaffUserIds = [],
  periodKey = 'lifetime',
) {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error(
      '[RANK CARD MEMBER FETCH ERROR]',
      error,
    );
  }

  const hidden =
    new Set(
      (
        hiddenStaffUserIds ||
        []
      ).map(
        String,
      ),
    );

  return [
    ...guild.members.cache.values(),
  ]
    .filter(
      (member) =>
        !member.user.bot &&
        isStaffMember(
          member,
        ) &&
        !hidden.has(
          member.id,
        ),
    )
    .map(
      (member) => {
        const tickets =
          snapshot.claimCounts.get(
            member.id,
          ) ||
          0;

        const messages =
          snapshot.messageCounts.get(
            member.id,
          ) ||
          0;

        const pointOverride =
          pointOverrides?.get(
            member.id,
          ) || null;

        const points = calculateStaffActivityPoints(
          tickets,
          messages,
          pointSettings,
          pointOverride,
          periodKey,
        );
        return { member, tickets, messages, ...points };
      },
    )
    .sort(
      (a, b) => {
        // Keep /rank in EXACT alignment with /staff-stats:
        // primary order is total configured activity points.
        if (
          b.activityScore !==
          a.activityScore
        ) {
          return (
            b.activityScore -
            a.activityScore
          );
        }

        // Same points-based tie-breakers as /staff-stats.
        if (
          b.ticketPoints !==
          a.ticketPoints
        ) {
          return (
            b.ticketPoints -
            a.ticketPoints
          );
        }

        if (
          b.messagePoints !==
          a.messagePoints
        ) {
          return (
            b.messagePoints -
            a.messagePoints
          );
        }

        return (
          a.member.displayName ||
          a.member.user.username
        ).localeCompare(
          b.member.displayName ||
          b.member.user.username,
          undefined,
          {
            sensitivity:
              'base',
          },
        );
      },
    );
}

function posterNameFontSize(value) {
  const length = String(value || '').length;

  if (length <= 10) return 76;
  if (length <= 14) return 66;
  if (length <= 18) return 58;
  if (length <= 22) return 50;
  return 44;
}

async function renderRankCard(guild, member, periodKey) {
  const [
    snapshot,
    pointSettings,
    pointOverrides,
  ] = await Promise.all([
    getStaffSnapshot(guild.id, periodKey),
    getStaffTrackingSettings(guild.id),
    getStaffPointOverridesForPeriod(
      guild.id,
      periodKey,
    ),
  ]);

  const hiddenStaffIds = new Set(
    pointSettings.hiddenStaffUserIds || [],
  );
  const isRankHidden = hiddenStaffIds.has(member.id);

  const rows =
    await getRankRows(
      guild,
      snapshot,
      pointSettings,
      pointOverrides,
      pointSettings.hiddenStaffUserIds,
      periodKey,
    );

  const rankIndex = rows.findIndex(
    (row) => row.member.id === member.id,
  );

  const tickets =
    snapshot.claimCounts.get(member.id) || 0;

  const messages =
    snapshot.messageCounts.get(member.id) || 0;

  const rank =
    !isRankHidden &&
    rankIndex >=
      0
      ? rankIndex +
        1
      : null;

  if (
    rank !==
    null
  ) {
    const rankingRow =
      rows[
        rankIndex
      ];

    console.log(
      `[RANK ORDER] ${member.id}: rank=${rank}/${rows.length}, ` +
        `points=${rankingRow.activityScore}, ` +
        `ticketPoints=${rankingRow.ticketPoints}, ` +
        `messagePoints=${rankingRow.messagePoints}, period=${periodKey}`,
    );
  }

  const starLevel =
    getStarLevel(member);

  const warningCount =
    getWarningCount(member);

  const rankedRow =
    rankIndex >=
      0
      ? rows[
          rankIndex
        ]
      : null;

  const memberOverride =
    pointOverrides?.get(
      member.id,
    ) ||
    null;

  const memberActivity =
    calculateStaffActivityPoints(
      tickets,
      messages,
      pointSettings,
      memberOverride,
      periodKey,
    );

  const score =
    rankedRow
      ?.activityScore ??
    memberActivity.activityScore;

  // The two stat tiles are always activity COUNTS. Ticket/message points are
  // separate scoring values used by Activity Score, XP and leaderboard rank.
  const displayedTicketValue =
    rankedRow?.ticketClaims ??
    memberActivity.ticketClaims;

  const displayedMessageValue =
    rankedRow?.trackedMessages ??
    memberActivity.trackedMessages;

  const scoreValueFontSize = Math.min(68, Math.floor(210 / (score.toLocaleString().length * 0.65)));
  const ticketValueFontSize = Math.min(68, Math.floor(210 / (displayedTicketValue.toLocaleString().length * 0.65)));
  const messageValueFontSize = Math.min(68, Math.floor(210 / (displayedMessageValue.toLocaleString().length * 0.65)));

  const ticketStatLine1 =
    'TICKETS';

  const ticketStatLine2 =
    'CLAIMED';

  const messageStatLine1 =
    'TRACKED';

  const messageStatLine2 =
    'MESSAGES';

  const xp =
    getXpState(
      score,
    );

  const avatarPng =
    await fetchAvatarPng(member);

  const avatarData =
    `data:image/png;base64,${avatarPng.toString('base64')}`;

  const rawDisplayName =
    member.displayName ||
    member.user.globalName ||
    member.user.username;

  const normalizedDisplayName =
    safeCardText(
      rawDisplayName,
      member.user.username,
    ).slice(0, 28);

  const displayName =
    escapeXml(normalizedDisplayName);

  const username =
    escapeXml(
      `@${safeCardText(
        member.user.username,
        member.user.id,
      ).slice(0, 30)}`,
    );

  const period =
    escapeXml(
      PERIOD_LABELS[periodKey] ||
        PERIOD_LABELS.lifetime,
    );

  const starText =
    starLevel === 2
      ? '2-STAR MANAGEMENT'
      : starLevel === 1
        ? '1-STAR MANAGEMENT'
        : 'STAFF';

  const warningText =
    warningCount > 0
      ? `${warningCount} WARNING ROLE${
          warningCount === 1
            ? ''
            : 'S'
        }`
      : 'NO WARNING ROLES';

  const progressPercent =
    Math.round(
      xp.progress * 100,
    );

  const progressWidth =
    xp.progress > 0
      ? Math.max(
          12,
          Math.round(
            1280 * xp.progress,
          ),
        )
      : 0;

  const displayRank =
    isRankHidden
      ? 'RANK HIDDEN'
      : `RANK #${rank}`;

  const nameFontSize =
    posterNameFontSize(
      normalizedDisplayName,
    );

  const ticketPointLabel = `${pointSettings.ticketClaimPoints} pts / claim`;
  const messagePointLabel = `${pointSettings.trackedMessagePoints} pts / message`;
  const manualOverrideLabel = rankedRow?.ticketPointsManual || rankedRow?.messagePointsManual
    ? ' • Manual totals' : '';

  const starMarkup =
    starLevel === 2
      ? `
        <polygon points="106,570 117,596 145,598 123,616 131,644 106,628 81,644 89,616 67,598 95,596"
                 fill="#f8c94d"/>
        <polygon points="166,570 177,596 205,598 183,616 191,644 166,628 141,644 149,616 127,598 155,596"
                 fill="#f8c94d"/>`
      : starLevel === 1
        ? `
          <polygon points="132,570 143,596 171,598 149,616 157,644 132,628 107,644 115,616 93,598 121,596"
                   fill="#f8c94d"/>`
        : `
          <circle cx="132" cy="610" r="20"
                  fill="#43d9d0" opacity=".94"/>`;

  const warningMarkup =
    warningCount > 0
      ? `
        <polygon points="132,684 155,724 109,724"
                 fill="#ffb65c"/>
        <rect x="129" y="697" width="6" height="15"
              rx="3" fill="#141821"/>
        <circle cx="132" cy="718" r="3"
                fill="#141821"/>`
      : `
        <circle cx="132" cy="704" r="28"
                fill="none" stroke="#78dda5" stroke-width="6"/>
        <path d="M116 704l11 11 23-25"
              fill="none" stroke="#78dda5"
              stroke-width="7" stroke-linecap="round"
              stroke-linejoin="round"/>`;

  const svg = `
  <svg width="1536" height="1024"
       viewBox="0 0 1536 1024"
       xmlns="http://www.w3.org/2000/svg">

    <defs>
      <linearGradient id="borderGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#25e4dc"/>
        <stop offset=".48" stop-color="#52b6ff"/>
        <stop offset="1" stop-color="#a13cff"/>
      </linearGradient>

      <linearGradient id="accentGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#26ddd6"/>
        <stop offset=".52" stop-color="#55b8ff"/>
        <stop offset="1" stop-color="#9a42ff"/>
      </linearGradient>

      <linearGradient id="backgroundGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#07121f"/>
        <stop offset=".48" stop-color="#07111d"/>
        <stop offset="1" stop-color="#0b1024"/>
      </linearGradient>

      <linearGradient id="panelGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#09192b"/>
        <stop offset="1" stop-color="#090e1f"/>
      </linearGradient>

      <radialGradient id="rightGlow" cx="1" cy=".5" r=".75">
        <stop offset="0" stop-color="#32296d" stop-opacity=".34"/>
        <stop offset="1" stop-color="#08111f" stop-opacity="0"/>
      </radialGradient>

      <pattern id="dotPattern" width="16" height="16"
               patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.7"
                fill="#58a6ff" opacity=".18"/>
      </pattern>

      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="12"
                      stdDeviation="20"
                      flood-color="#000000"
                      flood-opacity=".34"/>
      </filter>

      <filter id="cyanGlow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="5" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>

      <clipPath id="avatarClip">
        <circle cx="226" cy="226" r="126"/>
      </clipPath>

      <clipPath id="progressClip">
        <rect x="112" y="424" width="1312" height="64" rx="32"/>
      </clipPath>
    </defs>

    <!-- Main poster -->
    <rect x="16" y="16"
          width="1504" height="992"
          rx="40"
          fill="url(#backgroundGradient)"
          stroke="url(#borderGradient)"
          stroke-width="3"/>

    <rect x="18" y="18"
          width="1500" height="988"
          rx="38"
          fill="url(#rightGlow)"/>

    <!-- subtle diagonal background geometry -->
    <path d="M1210 18H1517V340L1118 724L980 724L1450 245z"
          fill="#16154a" opacity=".16"/>
    <path d="M1010 1002L1518 494V1002z"
          fill="#271160" opacity=".12"/>
    <rect x="1290" y="20"
          width="220" height="225"
          fill="url(#dotPattern)"
          opacity=".66"/>

    <!-- avatar -->
    <circle cx="226" cy="226" r="146"
            fill="#040914"
            stroke="url(#accentGradient)"
            stroke-width="5"
            filter="url(#softShadow)"/>

    <circle cx="226" cy="226" r="132"
            fill="#060b16"
            stroke="#ffffff"
            stroke-opacity=".18"
            stroke-width="2"/>

    <image href="${avatarData}"
           x="100" y="100"
           width="252" height="252"
           preserveAspectRatio="xMidYMid slice"
           clip-path="url(#avatarClip)"/>

    <!-- name -->
    <text x="402" y="175"
          font-family="DejaVu Sans, sans-serif"
          font-size="${nameFontSize}"
          font-weight="800"
          letter-spacing="1"
          fill="#ffffff">${displayName}</text>

    <text x="404" y="226"
          font-family="DejaVu Sans, sans-serif"
          font-size="34"
          fill="#9ba9bc">${username}</text>

    <!-- period pill -->
    <rect x="1210" y="93"
          width="224" height="68"
          rx="34"
          fill="#09111f"
          stroke="url(#accentGradient)"
          stroke-width="2"/>

    <text x="1322" y="137"
          text-anchor="middle"
          font-family="DejaVu Sans, sans-serif"
          font-size="28"
          font-weight="800"
          fill="#ffffff">${period}</text>

    <!-- Level / rank -->
    <text x="404" y="320"
          font-family="DejaVu Sans, sans-serif"
          font-size="58"
          font-weight="800">
      <tspan fill="url(#accentGradient)">LEVEL</tspan>
      <tspan fill="#ffffff"> ${xp.level}</tspan>
    </text>

    <text x="406" y="370"
          font-family="DejaVu Sans, sans-serif"
          font-size="34"
          fill="#adb8c8">
      XP ${xp.currentXp.toLocaleString()} / ${xp.requiredXp.toLocaleString()}
    </text>

    <line x1="816" y1="276"
          x2="816" y2="374"
          stroke="#7f8998"
          stroke-opacity=".55"
          stroke-width="2"/>

    <text x="927" y="323"
          font-family="DejaVu Sans, sans-serif"
          font-size="${isRankHidden ? 48 : 58}"
          font-weight="800"
          fill="#ffffff">${escapeXml(displayRank)}</text>

    <text x="927" y="370"
          font-family="DejaVu Sans, sans-serif"
          font-size="30"
          font-weight="700"
          fill="#adb8c8">
      ${progressPercent}% TO NEXT LEVEL
    </text>

    <!-- Progress bar -->
    <rect x="94" y="407"
          width="1348" height="98"
          rx="34"
          fill="#07101d"
          stroke="#3b4658"
          stroke-width="2"/>

    <rect x="112" y="424"
          width="1312" height="64"
          rx="32"
          fill="#040a13"
          stroke="#2d3949"
          stroke-width="2"/>

    <g clip-path="url(#progressClip)">
      <rect x="112" y="424"
            width="${progressWidth}"
            height="64"
            fill="url(#accentGradient)"/>
      <rect x="112" y="424"
            width="${progressWidth}"
            height="12"
            fill="#ffffff"
            opacity=".14"/>
    </g>

    <!-- Left status column -->
    ${starMarkup}

    <line x1="210" y1="571"
          x2="210" y2="648"
          stroke="#617084"
          stroke-opacity=".55"/>

    <text x="220" y="622"
          font-family="DejaVu Sans, sans-serif"
          font-size="30"
          font-weight="800"
          fill="#35dbd4">${escapeXml(starText)}</text>

    <line x1="84" y1="663"
          x2="516" y2="663"
          stroke="#647083"
          stroke-opacity=".35"/>

    ${warningMarkup}

    <line x1="210" y1="670"
          x2="210" y2="738"
          stroke="#617084"
          stroke-opacity=".55"/>

    <text x="220" y="716"
          font-family="DejaVu Sans, sans-serif"
          font-size="30"
          font-weight="800"
          fill="${warningCount ? '#ffb65c' : '#78dda5'}">${escapeXml(warningText)}</text>

    <line x1="84" y1="756"
          x2="516" y2="756"
          stroke="#647083"
          stroke-opacity=".35"/>

    <!-- Performance XP -->
    <text x="94" y="823"
          font-family="DejaVu Sans, sans-serif"
          font-size="26"
          letter-spacing="1"
          fill="#8291a7">PERFORMANCE XP</text>

    <text x="94" y="895"
          font-family="DejaVu Sans, sans-serif"
          font-size="64"
          font-weight="800">
      <tspan fill="url(#accentGradient)">${xp.totalXp.toLocaleString()}</tspan>
      <tspan fill="#ffffff"> TOTAL XP</tspan>
    </text>

    <!-- Stat card: tickets -->
    <rect x="610" y="535"
          width="255" height="224"
          rx="24"
          fill="url(#panelGradient)"
          stroke="url(#accentGradient)"
          stroke-width="1.5"/>

    <circle cx="672" cy="599" r="38"
            fill="#081426"
            stroke="url(#accentGradient)"
            stroke-width="2"/>

    <!-- clean ticket icon -->
    <path d="M650 582
             H690
             C690 590 696 594 704 594
             V604
             C696 604 690 608 690 616
             H650
             C650 608 644 604 636 604
             V594
             C644 594 650 590 650 582Z"
          fill="none"
          stroke="#26ded6"
          stroke-width="3.5"
          stroke-linejoin="round"/>
    <line x1="670" y1="586"
          x2="670" y2="612"
          stroke="#26ded6"
          stroke-width="2.5"
          stroke-dasharray="4 5"
          stroke-linecap="round"/>

    <text x="724" y="589"
          font-family="DejaVu Sans, sans-serif"
          font-size="24"
          font-weight="800"
          fill="#ffffff">${ticketStatLine1}</text>
    <text x="724" y="621"
          font-family="DejaVu Sans, sans-serif"
          font-size="24"
          font-weight="800"
          fill="#ffffff">${ticketStatLine2}</text>

    <line x1="638" y1="658"
          x2="837" y2="658"
          stroke="url(#accentGradient)"
          stroke-width="3"
          stroke-dasharray="3 10"
          stroke-linecap="round"/>

    <text x="738" y="724"
          text-anchor="middle"
          font-family="DejaVu Sans, sans-serif"
          font-size="${ticketValueFontSize}"
          font-weight="800"
          fill="#ffffff">${displayedTicketValue.toLocaleString()}</text>

    <!-- Stat card: messages -->
    <rect x="895" y="535"
          width="255" height="224"
          rx="24"
          fill="url(#panelGradient)"
          stroke="url(#accentGradient)"
          stroke-width="1.5"/>

    <circle cx="957" cy="599" r="38"
            fill="#081426"
            stroke="url(#accentGradient)"
            stroke-width="2"/>

    <!-- chat icon -->
    <rect x="937" y="584"
          width="40" height="29"
          rx="7"
          fill="none"
          stroke="#31d9dc"
          stroke-width="3"/>
    <path d="M950 613l-8 10 1-10"
          fill="none"
          stroke="#31d9dc"
          stroke-width="3"
          stroke-linejoin="round"/>
    <circle cx="948" cy="598" r="2.4" fill="#31d9dc"/>
    <circle cx="957" cy="598" r="2.4" fill="#31d9dc"/>
    <circle cx="966" cy="598" r="2.4" fill="#31d9dc"/>

    <text x="1006" y="589"
          font-family="DejaVu Sans, sans-serif"
          font-size="23"
          font-weight="800"
          fill="#ffffff">${messageStatLine1}</text>
    <text x="1006" y="621"
          font-family="DejaVu Sans, sans-serif"
          font-size="23"
          font-weight="800"
          fill="#ffffff">${messageStatLine2}</text>

    <line x1="923" y1="658"
          x2="1122" y2="658"
          stroke="url(#accentGradient)"
          stroke-width="3"
          stroke-dasharray="3 10"
          stroke-linecap="round"/>

    <text x="1022" y="724"
          text-anchor="middle"
          font-family="DejaVu Sans, sans-serif"
          font-size="${messageValueFontSize}"
          font-weight="800"
          fill="#ffffff">${displayedMessageValue.toLocaleString()}</text>

    <!-- Stat card: score -->
    <rect x="1180" y="535"
          width="255" height="224"
          rx="24"
          fill="url(#panelGradient)"
          stroke="url(#accentGradient)"
          stroke-width="1.5"/>

    <circle cx="1242" cy="599" r="38"
            fill="#081426"
            stroke="url(#accentGradient)"
            stroke-width="2"/>

    <!-- activity icon -->
    <polyline points="1222,615 1237,600 1248,608 1264,589"
              fill="none"
              stroke="#4ab8ff"
              stroke-width="5"
              stroke-linecap="round"
              stroke-linejoin="round"/>
    <polyline points="1255,589 1264,589 1264,598"
              fill="none"
              stroke="#4ab8ff"
              stroke-width="5"
              stroke-linecap="round"
              stroke-linejoin="round"/>

    <text x="1290" y="589"
          font-family="DejaVu Sans, sans-serif"
          font-size="22"
          font-weight="800"
          fill="#ffffff">ACTIVITY</text>
    <text x="1290" y="621"
          font-family="DejaVu Sans, sans-serif"
          font-size="22"
          font-weight="800"
          fill="#ffffff">SCORE</text>

    <line x1="1208" y1="658"
          x2="1407" y2="658"
          stroke="url(#accentGradient)"
          stroke-width="3"
          stroke-dasharray="3 10"
          stroke-linecap="round"/>

    <text x="1307" y="724"
          text-anchor="middle"
          font-family="DejaVu Sans, sans-serif"
          font-size="${scoreValueFontSize}"
          font-weight="800"
          fill="#ffffff">${score.toLocaleString()}</text>

    <!-- Scoring model -->
    <rect x="610" y="779"
          width="825" height="133"
          rx="24"
          fill="url(#panelGradient)"
          stroke="url(#accentGradient)"
          stroke-width="1.5"/>

    <circle cx="678" cy="845"
            r="38"
            fill="#081426"
            stroke="url(#accentGradient)"
            stroke-width="2"/>
    <circle cx="678" cy="845"
            r="27"
            fill="#07111f"
            stroke="#24425f"
            stroke-width="1.5"/>

    <!-- target icon -->
    <circle cx="678" cy="845" r="18"
            fill="none" stroke="#668cff" stroke-width="4"/>
    <circle cx="678" cy="845" r="7"
            fill="none" stroke="#32d9d5" stroke-width="4"/>
    <line x1="678" y1="819" x2="678" y2="829"
          stroke="#668cff" stroke-width="4"/>
    <line x1="678" y1="861" x2="678" y2="871"
          stroke="#668cff" stroke-width="4"/>
    <line x1="652" y1="845" x2="662" y2="845"
          stroke="#668cff" stroke-width="4"/>
    <line x1="694" y1="845" x2="704" y2="845"
          stroke="#668cff" stroke-width="4"/>

    <text x="738" y="829"
          font-family="DejaVu Sans, sans-serif"
          font-size="28"
          font-weight="800"
          fill="#ffffff">SCORING MODEL</text>

    <text x="738" y="868"
          font-family="DejaVu Sans, sans-serif"
          font-size="25"
          fill="#aeb9c9">${escapeXml(ticketPointLabel)} • ${escapeXml(messagePointLabel)}${escapeXml(manualOverrideLabel)}</text>

    <!-- footer -->
    <line x1="84" y1="958"
          x2="650" y2="958"
          stroke="#728096"
          stroke-opacity=".45"/>

    <line x1="886" y1="958"
          x2="1432" y2="958"
          stroke="#728096"
          stroke-opacity=".45"/>

    <text x="768" y="966"
          text-anchor="middle"
          font-family="DejaVu Sans, sans-serif"
          font-size="28"
          font-weight="700"
          fill="#8f9db1">Snay.io</text>

  </svg>`;

  return sharp(
    Buffer.from(svg),
  )
    .png({
      compressionLevel: 9,
    })
    .toBuffer();
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
    !interaction.__snayPermissionAuthorized &&
    (
      !requester ||
      !requester.permissions.has(PermissionFlagsBits.ViewAuditLog)
    )
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
    !isStaffMember(member)
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
