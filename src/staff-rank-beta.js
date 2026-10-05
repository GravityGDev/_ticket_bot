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
  getHighestStaffRoleId,
  isBotDeveloper,
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

    return sharp(Buffer.from(await response.arrayBuffer()))
      .resize(320, 320, { fit: 'cover' })
      .png()
      .toBuffer();
  } catch (error) {
    console.error('[RANK BETA AVATAR ERROR]', error);

    return sharp(Buffer.from(`
      <svg width="320" height="320" xmlns="http://www.w3.org/2000/svg">
        <rect width="320" height="320" rx="160" fill="#091425"/>
        <circle cx="160" cy="124" r="60" fill="#53627b"/>
        <path d="M62 292c17-70 60-102 98-102s81 32 98 102" fill="#53627b"/>
      </svg>
    `)).png().toBuffer();
  }
}

async function getRankRows(guild, snapshot, pointSettings, pointOverrides, hiddenStaffUserIds = [], periodKey = 'lifetime') {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[RANK BETA MEMBER FETCH ERROR]', error);
  }

  const hidden = new Set((hiddenStaffUserIds || []).map(String));

  return [...guild.members.cache.values()]
    .filter((member) => !member.user.bot && isStaffMember(member) && !hidden.has(member.id))
    .map((member) => {
      const tickets = snapshot.claimCounts.get(member.id) || 0;
      const messages = snapshot.messageCounts.get(member.id) || 0;
      const pointOverride = pointOverrides?.get(member.id) || null;
      const points = calculateStaffActivityPoints(
        tickets,
        messages,
        pointSettings,
        pointOverride,
        periodKey,
      );

      return { member, tickets, messages, ...points };
    })
    .sort((a, b) => {
      if (b.activityScore !== a.activityScore) return b.activityScore - a.activityScore;
      if (b.ticketPoints !== a.ticketPoints) return b.ticketPoints - a.ticketPoints;
      if (b.messagePoints !== a.messagePoints) return b.messagePoints - a.messagePoints;

      return (a.member.displayName || a.member.user.username).localeCompare(
        b.member.displayName || b.member.user.username,
        undefined,
        { sensitivity: 'base' },
      );
    });
}

function nameFontSize(value) {
  const length = String(value || '').length;
  if (length <= 10) return 80;
  if (length <= 14) return 70;
  if (length <= 18) return 60;
  if (length <= 22) return 52;
  return 44;
}

function identityFontSize(name, suffix) {
  const length = String(name || '').length + String(suffix || '').length;
  if (length <= 15) return 76;
  if (length <= 20) return 68;
  if (length <= 25) return 60;
  if (length <= 31) return 52;
  return 44;
}

function validRoleColor(value, fallback = '#58a6ff') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== '#000000'
    ? color
    : fallback;
}

function truncateDecimal(value, places = 2) {
  const factor = 10 ** places;
  return Math.trunc((Number(value) || 0) * factor) / factor;
}

function formatCompactXp(value) {
  const number = Math.max(0, Number(value) || 0);

  const units = [
    { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: 'b' },
    { threshold: 1_000_000, divisor: 1_000_000, suffix: 'm' },
    { threshold: 1_000, divisor: 1_000, suffix: 'k' },
  ];

  const unit = units.find((entry) => number >= entry.threshold);

  if (!unit) {
    return Number.isInteger(number)
      ? number.toLocaleString()
      : truncateDecimal(number, 2).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  const compact = truncateDecimal(number / unit.divisor, 2);
  const formatted = compact
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1');

  return `${formatted}${unit.suffix}`;
}

function estimateSvgTextWidth(value, fontSize) {
  return [...String(value || '')].length * Number(fontSize) * 0.58;
}

function fitRoleFontSize(value, maxWidth, maxSize = 34, minSize = 19) {
  for (let size = maxSize; size >= minSize; size -= 1) {
    if (estimateSvgTextWidth(value, size) <= maxWidth) return size;
  }
  return minSize;
}

function buildRoleTextLayout(value, maxWidth = 308) {
  const text = String(value || '').trim();

  const singleSize = fitRoleFontSize(text, maxWidth, 34, 23);
  if (estimateSvgTextWidth(text, singleSize) <= maxWidth) {
    return {
      lines: [text],
      fontSize: singleSize,
      lineYs: [618],
      permissionY: 662,
    };
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return {
      lines: [text],
      fontSize: fitRoleFontSize(text, maxWidth, 23, 18),
      lineYs: [618],
      permissionY: 662,
    };
  }

  let best = null;
  for (let split = 1; split < words.length; split += 1) {
    const first = words.slice(0, split).join(' ');
    const second = words.slice(split).join(' ');
    const longest = Math.max(first.length, second.length);
    if (!best || longest < best.longest) best = { first, second, longest };
  }

  const lineSize = Math.min(
    fitRoleFontSize(best.first, maxWidth, 29, 19),
    fitRoleFontSize(best.second, maxWidth, 29, 19),
  );

  return {
    lines: [best.first, best.second],
    fontSize: lineSize,
    lineYs: [604, 638],
    permissionY: 678,
  };
}

function numberFontSize(value, max = 62) {
  const length = String(value).length;
  if (length <= 4) return max;
  if (length <= 6) return max - 6;
  if (length <= 8) return max - 12;
  return max - 18;
}

async function renderRankBetaCard(guild, member, periodKey = 'lifetime') {
  const [snapshot, pointSettings, pointOverrides] = await Promise.all([
    getStaffSnapshot(guild.id, periodKey),
    getStaffTrackingSettings(guild.id),
    getStaffPointOverridesForPeriod(guild.id, periodKey),
  ]);

  const hiddenStaffIds = new Set(pointSettings.hiddenStaffUserIds || []);
  const isRankHidden = hiddenStaffIds.has(member.id);

  const rows = await getRankRows(
    guild,
    snapshot,
    pointSettings,
    pointOverrides,
    pointSettings.hiddenStaffUserIds,
    periodKey,
  );

  const rankIndex = rows.findIndex((row) => row.member.id === member.id);
  const rankedRow = rankIndex >= 0 ? rows[rankIndex] : null;
  const tickets = snapshot.claimCounts.get(member.id) || 0;
  const messages = snapshot.messageCounts.get(member.id) || 0;
  const rank = !isRankHidden && rankIndex >= 0 ? rankIndex + 1 : null;

  const memberOverride = pointOverrides?.get(member.id) || null;
  const memberActivity = calculateStaffActivityPoints(
    tickets,
    messages,
    pointSettings,
    memberOverride,
    periodKey,
  );

  const score = rankedRow?.activityScore ?? memberActivity.activityScore;

  // These tiles are counts only; point overrides stay in scoring/XP.
  const displayedTicketValue =
    rankedRow?.ticketClaims ?? memberActivity.ticketClaims;
  const displayedMessageValue =
    rankedRow?.trackedMessages ?? memberActivity.trackedMessages;

  const ticketStatLine1 = 'TICKETS';
  const ticketStatLine2 = 'CLAIMED';
  const messageStatLine1 = 'TRACKED';
  const messageStatLine2 = 'MESSAGES';

  const xp = getXpState(score);
  const progressPercent = Math.round(xp.progress * 100);
  const progressWidth = xp.progress > 0
    ? Math.max(18, Math.round(1310 * xp.progress))
    : 0;

  const avatarPng = await fetchAvatarPng(member);
  const avatarData = `data:image/png;base64,${avatarPng.toString('base64')}`;

  const rawDisplayName = member.displayName || member.user.globalName || member.user.username;
  const normalizedDisplayName = safeCardText(rawDisplayName, member.user.username).slice(0, 28);
  const displayName = escapeXml(normalizedDisplayName);
  const username = escapeXml(`@${safeCardText(member.user.username, member.user.id).slice(0, 30)}`);
  const period = escapeXml(PERIOD_LABELS[periodKey] || PERIOD_LABELS.lifetime);

  const starLevel = getStarLevel(member);
  const warningCount = getWarningCount(member);
  const developer = isBotDeveloper(member);
  const permissionLabel = developer
    ? 'Dev'
    : member.permissions?.has(PermissionFlagsBits.Administrator)
      ? 'Admin'
      : 'Mod';

  const statusParts = [];
  if (!developer && starLevel > 0) statusParts.push('★'.repeat(starLevel));
  if (!developer && warningCount > 0) statusParts.push('⚠'.repeat(warningCount));

  const identitySuffix = developer
    ? ' • Dev'
    : `${statusParts.length ? ` • ${statusParts.join(' ')}` : ''} • ${permissionLabel}`;

  const highestStaffRoleId = getHighestStaffRoleId(member);
  const highestStaffRole = highestStaffRoleId
    ? member.roles.cache.get(highestStaffRoleId)
    : null;
  const highestStaffRoleName = safeCardText(
    highestStaffRole?.name || (developer ? 'Developer' : permissionLabel),
    developer ? 'Developer' : permissionLabel,
  ).slice(0, 30);
  const highestStaffRoleColor = validRoleColor(
    highestStaffRole?.hexColor,
    developer ? '#8b7cff' : '#58a6ff',
  );
  const permissionDetail = developer
    ? 'BOT DEVELOPER'
    : permissionLabel === 'Admin'
      ? 'ADMIN PERMS'
      : 'MOD PERMS';

  const displayRank = isRankHidden ? 'RANK HIDDEN' : `RANK #${rank}`;
  const rankFontSize = isRankHidden ? 42 : 56;
  const displayNameFontSize = identityFontSize(
    normalizedDisplayName,
    identitySuffix,
  );
  const ticketValueFontSize = numberFontSize(displayedTicketValue.toLocaleString());
  const messageValueFontSize = numberFontSize(displayedMessageValue.toLocaleString());
  const scoreValueFontSize = numberFontSize(score.toLocaleString());
  const totalXpFontSize = numberFontSize(xp.totalXp.toLocaleString(), 66);

  const ticketPointLabel = `${pointSettings.ticketClaimPoints} pts / claim`;
  const messagePointLabel = `${pointSettings.trackedMessagePoints} pts / message`;
  const svg = `
  <svg width="1536" height="1024" viewBox="0 0 1536 1024" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#18e5ec"/>
        <stop offset=".48" stop-color="#4297ff"/>
        <stop offset="1" stop-color="#a53eff"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#1de1e2"/>
        <stop offset=".54" stop-color="#4f9cff"/>
        <stop offset="1" stop-color="#a345ff"/>
      </linearGradient>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#061320"/>
        <stop offset=".50" stop-color="#07111f"/>
        <stop offset="1" stop-color="#0c0b25"/>
      </linearGradient>
      <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0a1d31"/>
        <stop offset=".62" stop-color="#091326"/>
        <stop offset="1" stop-color="#100d2b"/>
      </linearGradient>
      <linearGradient id="panelBorder" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#32deea" stop-opacity=".95"/>
        <stop offset=".55" stop-color="#4678ff" stop-opacity=".78"/>
        <stop offset="1" stop-color="#9f43ff" stop-opacity=".95"/>
      </linearGradient>
      <radialGradient id="cornerGlow" cx="0" cy="0" r="1">
        <stop offset="0" stop-color="#0bdcea" stop-opacity=".33"/>
        <stop offset=".50" stop-color="#2464d9" stop-opacity=".09"/>
        <stop offset="1" stop-color="#07111f" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="rightGlow" cx="1" cy="1" r="1">
        <stop offset="0" stop-color="#7734ff" stop-opacity=".24"/>
        <stop offset=".55" stop-color="#2c31a8" stop-opacity=".09"/>
        <stop offset="1" stop-color="#07111f" stop-opacity="0"/>
      </radialGradient>
      <filter id="frameGlow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="6" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="goldGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="warmGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <clipPath id="avatarClip"><circle cx="222" cy="204" r="119"/></clipPath>
      <clipPath id="progressClip"><rect x="106" y="413" width="1310" height="54" rx="27"/></clipPath>
    </defs>

    <rect width="1536" height="1024" fill="#030914"/>
    <ellipse cx="190" cy="80" rx="420" ry="330" fill="url(#cornerGlow)"/>
    <ellipse cx="1410" cy="900" rx="510" ry="420" fill="url(#rightGlow)"/>

    <rect x="24" y="24" width="1488" height="976" rx="40" fill="url(#bg)" stroke="url(#frame)" stroke-width="3" filter="url(#frameGlow)"/>
    <rect x="26" y="26" width="1484" height="972" rx="38" fill="none" stroke="#8fdfff" stroke-opacity=".10"/>

    <path d="M775 28L930 28L822 137L956 193L833 324" fill="none" stroke="#304fa0" stroke-opacity=".10" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M1510 676L1268 998H1510Z" fill="#4b1ea1" opacity=".06"/>

    <circle cx="222" cy="204" r="143" fill="#050b16" stroke="url(#accent)" stroke-width="7" filter="url(#softGlow)"/>
    <circle cx="222" cy="204" r="130" fill="#07101c" stroke="#9fdcff" stroke-opacity=".25" stroke-width="2"/>
    <image href="${avatarData}" x="103" y="85" width="238" height="238" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>
    <circle cx="328" cy="304" r="18" fill="url(#accent)" stroke="#bffcff" stroke-width="2" filter="url(#softGlow)"/>

    <text x="410" y="145" font-family="DejaVu Sans, sans-serif" font-size="${displayNameFontSize}" font-weight="800">
      <tspan fill="#ffffff">${displayName}</tspan>
      ${developer
        ? '<tspan fill="#8b7cff"> • Dev</tspan>'
        : `${statusParts.length ? `<tspan fill="#ffd15a"> • ${escapeXml(statusParts.join(' '))}</tspan>` : ''}<tspan fill="#7ebdff"> • ${escapeXml(permissionLabel)}</tspan>`}
    </text>
    <text x="412" y="194" font-family="DejaVu Sans, sans-serif" font-size="32" fill="#9fb0c9">${username}</text>

    <text x="1438" y="116" text-anchor="end"
          font-family="DejaVu Sans, sans-serif"
          font-size="25" font-weight="800" letter-spacing="1.2"
          fill="#ffffff">${period}</text>
    <line x1="1248" y1="137" x2="1438" y2="137"
          stroke="url(#accent)" stroke-width="3" stroke-linecap="round"
          opacity=".72"/>

    <path d="M452 236L497 262L497 316L452 342L407 316L407 262Z" fill="#07162a" stroke="#24dfea" stroke-width="4" filter="url(#softGlow)"/>
    <path d="M452 248L486 268L486 310L452 330L418 310L418 268Z" fill="#0b1d34" stroke="#4b8cff" stroke-opacity=".55" stroke-width="2"/>
    <text x="452" y="278" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="700" fill="#d8ecff">LVL</text>
    <text x="452" y="315" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="43" font-weight="800" fill="#ffffff">${xp.level}</text>

    <text x="548" y="294" font-family="DejaVu Sans, sans-serif" font-size="52" font-weight="800">
      <tspan fill="#26dfe3">LEVEL</tspan><tspan fill="#ffffff"> ${xp.level}</tspan>
    </text>
    <text x="550" y="339" font-family="DejaVu Sans, sans-serif" font-size="30" fill="#aec1dd">XP ${xp.currentXp.toLocaleString()} / ${xp.requiredXp.toLocaleString()}</text>

    <line x1="838" y1="239" x2="838" y2="345" stroke="#8ca0bc" stroke-opacity=".45" stroke-width="2"/>

    <path d="M950 236L995 262L995 316L950 342L905 316L905 262Z" fill="#100d2b" stroke="#9050ff" stroke-width="4" filter="url(#softGlow)"/>
    <path d="M929 270h42v13c0 18-9 28-21 32-12-4-21-14-21-32z" fill="none" stroke="#bf73ff" stroke-width="4"/>
    <path d="M939 270v-8h22v8M950 315v12M938 328h24" fill="none" stroke="#bf73ff" stroke-width="4" stroke-linecap="round"/>
    <path d="M929 276h-9v6c0 9 6 15 14 16M971 276h9v6c0 9-6 15-14 16" fill="none" stroke="#bf73ff" stroke-width="3"/>

    <text x="1035" y="294" font-family="DejaVu Sans, sans-serif" font-size="${rankFontSize}" font-weight="800" fill="#ffffff">${escapeXml(displayRank)}</text>
    <text x="1037" y="338" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="700" fill="#aebbd0">${progressPercent}% TO NEXT LEVEL</text>
    <line x1="1037" y1="350" x2="1128" y2="350" stroke="url(#accent)" stroke-width="3" stroke-linecap="round"/>

    <rect x="72" y="389" width="1392" height="101" rx="36" fill="#07111e" stroke="#2a4565" stroke-width="2"/>
    <rect x="88" y="405" width="1360" height="69" rx="34" fill="#040a13" stroke="url(#panelBorder)" stroke-width="2"/>
    <g clip-path="url(#progressClip)">
      <rect x="106" y="413" width="${progressWidth}" height="54" fill="url(#accent)"/>
      <path d="M106 426C260 402 394 454 548 426S836 402 990 426S1278 454 1416 426" fill="none" stroke="#ffffff" stroke-opacity=".11" stroke-width="2"/>
      <path d="M106 445C260 421 394 473 548 445S836 421 990 445S1278 473 1416 445" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="2"/>
    </g>
    <text x="1416" y="449" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="25" fill="#8ea4c4">${progressPercent}%</text>

    <!-- Highest staff role replaces bulky star/warning panels -->
    <rect x="72" y="510" width="488" height="202" rx="26"
          fill="url(#panel)" stroke="url(#panelBorder)" stroke-width="1.5"/>
    <circle cx="143" cy="611" r="57"
            fill="#071426" stroke="${highestStaffRoleColor}" stroke-width="3"
            filter="url(#softGlow)"/>
    <path d="M143 572l34 15v26c0 24-14 41-34 51-20-10-34-27-34-51v-26z"
          fill="none" stroke="${highestStaffRoleColor}" stroke-width="4"
          stroke-linejoin="round"/>
    <path d="M128 614l10 10 21-24"
          fill="none" stroke="${highestStaffRoleColor}" stroke-width="5"
          stroke-linecap="round" stroke-linejoin="round"/>

    <text x="222" y="558" font-family="DejaVu Sans, sans-serif"
          font-size="20" font-weight="800" letter-spacing="3"
          fill="#8397b6">HIGHEST STAFF ROLE</text>
    <text x="222" y="612" font-family="DejaVu Sans, sans-serif"
          font-size="34" font-weight="800"
          fill="${highestStaffRoleColor}">${escapeXml(highestStaffRoleName)}</text>
    <text x="222" y="655" font-family="DejaVu Sans, sans-serif"
          font-size="22" font-weight="800"
          fill="#c6d2e6">${escapeXml(permissionDetail)}</text>

    <line x1="222" y1="679" x2="520" y2="679"
          stroke="${highestStaffRoleColor}" stroke-width="2.5"
          stroke-linecap="round" opacity=".65"/>

    <rect x="578" y="510" width="275" height="202" rx="24" fill="url(#panel)" stroke="url(#panelBorder)" stroke-width="1.5"/>
    <circle cx="648" cy="570" r="39" fill="#07182b" stroke="#1fe0e5" stroke-width="2.5" filter="url(#softGlow)"/>
    <path d="M625 553h46c0 8 6 12 13 12v11c-7 0-13 4-13 12h-46c0-8-6-12-13-12v-11c7 0 13-4 13-12z" fill="none" stroke="#2de3df" stroke-width="3"/>
    <line x1="648" y1="557" x2="648" y2="584" stroke="#2de3df" stroke-width="2.4" stroke-dasharray="4 5"/>
    <text x="712" y="558" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="800" fill="#ffffff">${ticketStatLine1}</text>
    <text x="712" y="589" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="800" fill="#ffffff">${ticketStatLine2}</text>
    <text x="715" y="674" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${ticketValueFontSize}" font-weight="800" fill="#ffffff">${displayedTicketValue.toLocaleString()}</text>

    <rect x="870" y="510" width="275" height="202" rx="24" fill="url(#panel)" stroke="url(#panelBorder)" stroke-width="1.5"/>
    <circle cx="940" cy="570" r="39" fill="#100d2b" stroke="#a24aff" stroke-width="2.5" filter="url(#softGlow)"/>
    <rect x="918" y="553" width="44" height="31" rx="8" fill="none" stroke="#b85fff" stroke-width="3"/>
    <path d="M930 584l-10 11 2-11" fill="none" stroke="#b85fff" stroke-width="3"/>
    <circle cx="930" cy="568" r="2.3" fill="#b85fff"/><circle cx="940" cy="568" r="2.3" fill="#b85fff"/><circle cx="950" cy="568" r="2.3" fill="#b85fff"/>
    <text x="1004" y="558" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="800" fill="#ffffff">${messageStatLine1}</text>
    <text x="1004" y="589" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="800" fill="#ffffff">${messageStatLine2}</text>
    <text x="1007" y="674" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${messageValueFontSize}" font-weight="800" fill="#ffffff">${displayedMessageValue.toLocaleString()}</text>

    <rect x="1162" y="510" width="302" height="202" rx="24" fill="url(#panel)" stroke="url(#panelBorder)" stroke-width="1.5"/>
    <circle cx="1233" cy="570" r="39" fill="#07182b" stroke="#1fe0e5" stroke-width="2.5" filter="url(#softGlow)"/>
    <polyline points="1212,584 1227,568 1239,576 1255,555" fill="none" stroke="#42b7ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="1247,555 1255,555 1255,563" fill="none" stroke="#42b7ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="1295" y="558" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="800" fill="#ffffff">ACTIVITY</text>
    <text x="1295" y="589" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="800" fill="#ffffff">SCORE</text>
    <text x="1313" y="674" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${scoreValueFontSize}" font-weight="800" fill="#ffffff">${score.toLocaleString()}</text>

    <rect x="72" y="733" width="711" height="158" rx="24" fill="url(#panel)" stroke="url(#panelBorder)" stroke-width="1.5"/>
    <text x="126" y="778" font-family="DejaVu Sans, sans-serif" font-size="22" letter-spacing="3" fill="#9eb1ce">PERFORMANCE XP</text>
    <text x="126" y="849" font-family="DejaVu Sans, sans-serif" font-size="${totalXpFontSize}" font-weight="800">
      <tspan fill="#29dfe3">${xp.totalXp.toLocaleString()}</tspan><tspan fill="#ffffff"> TOTAL XP</tspan>
    </text>

    <rect x="800" y="733" width="664" height="158" rx="24" fill="url(#panel)" stroke="url(#panelBorder)" stroke-width="1.5"/>
    <circle cx="874" cy="812" r="43" fill="#100d2b" stroke="#914bff" stroke-width="2"/>
    <circle cx="874" cy="812" r="27" fill="none" stroke="#885fff" stroke-width="4"/>
    <circle cx="874" cy="812" r="10" fill="none" stroke="#2fdede" stroke-width="4"/>
    <line x1="874" y1="774" x2="874" y2="787" stroke="#885fff" stroke-width="4"/><line x1="874" y1="837" x2="874" y2="850" stroke="#885fff" stroke-width="4"/>
    <line x1="836" y1="812" x2="849" y2="812" stroke="#885fff" stroke-width="4"/><line x1="899" y1="812" x2="912" y2="812" stroke="#885fff" stroke-width="4"/>
    <text x="950" y="801" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="800" fill="#ffffff">SCORING MODEL</text>
    <text x="950" y="840" font-family="DejaVu Sans, sans-serif" font-size="23" fill="#aebbd0">${escapeXml(ticketPointLabel)} • ${escapeXml(messagePointLabel)}</text>

    <line x1="266" y1="947" x2="658" y2="947" stroke="url(#accent)" stroke-opacity=".75"/>
    <line x1="878" y1="947" x2="1270" y2="947" stroke="url(#accent)" stroke-opacity=".75"/>
    <text x="768" y="958" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="29" font-weight="700" fill="#6596ff">Snay.io</text>
  </svg>`;

  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function sendRankBetaCard(interaction, periodKey = 'lifetime') {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Use this command inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isBotDeveloper(interaction.user)) {
    await interaction.reply({
      content: 'This beta rank card is currently developer-only.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedUser = interaction.options?.getUser('staff') || null;
  const targetId = selectedUser?.id || interaction.user.id;
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);

  if (!member || member.user.bot || !isStaffMember(member)) {
    await interaction.reply({
      content: `This user isn't Snay.io staff.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.deferReply();

  try {
    const card = await renderRankBetaCard(interaction.guild, member, periodKey);

    console.log(
      `[RANK BETA] Generated card for ${member.user.tag} (${member.id}) ` +
      `requested by ${interaction.user.tag} (${interaction.user.id}); period=${periodKey}.`,
    );

    await interaction.editReply({
      files: [
        new AttachmentBuilder(card, {
          name: `staff-rank-beta-${member.id}-${periodKey}.png`,
        }),
      ],
    });
  } catch (error) {
    console.error('[RANK BETA CARD ERROR]', error);
    await interaction.editReply({
      content: 'I could not generate the beta staff rank card.',
    });
  }
}

module.exports = {
  sendRankBetaCard,
  renderRankBetaCard,
};
