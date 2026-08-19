const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const {
  TRACKED_CATEGORY_IDS,
  getStaffSnapshot,
  getStaffDetail,
} = require('./staff-tracking-store');

const WARNING_ROLE_IDS = Object.freeze([
  '961199921841713162',
  '961199596212744252',
]);

const STAR_MANAGEMENT_ROLES = Object.freeze({
  oneStar: '955029841793650688',
  twoStar: '955030166797713408',
});

const STAR_MANAGEMENT_ROLE_IDS = Object.freeze(
  Object.values(STAR_MANAGEMENT_ROLES),
);

const PAGE_SIZE = 10;

const PERIODS = Object.freeze({
  weekly: {
    label: 'Weekly',
    description: 'Last 7 days',
  },
  monthly: {
    label: 'Monthly',
    description: 'Last 30 days',
  },
  quarterly: {
    label: 'Quarterly',
    description: 'Last 90 days',
  },
});

const FILTERS = Object.freeze({
  all: {
    label: 'All Staff',
  },
  star: {
    label: 'Star Management',
  },
  warnings: {
    label: 'Warning Roles',
  },
  clean: {
    label: 'No Warning Roles',
  },
  active_star: {
    label: 'Active Star Staff',
  },
});

function cleanPeriod(value) {
  return PERIODS[value] ? value : 'weekly';
}

function cleanFilter(value) {
  return FILTERS[value] ? value : 'all';
}

function hasAnyRole(member, roleIds) {
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function getStarLevel(member) {
  if (member.roles.cache.has(STAR_MANAGEMENT_ROLES.twoStar)) return 2;
  if (member.roles.cache.has(STAR_MANAGEMENT_ROLES.oneStar)) return 1;
  return 0;
}

function getStarBadge(starLevel) {
  if (starLevel >= 2) return '⭐⭐';
  if (starLevel === 1) return '⭐';
  return '';
}

function getRoleMentions(member, roleIds) {
  const present = roleIds.filter((roleId) => member.roles.cache.has(roleId));
  return present.length ? present.map((id) => `<@&${id}>`).join(' ') : 'None';
}

async function getCurrentStaffMembers(guild) {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[STAFF PANEL MEMBER FETCH ERROR]', error);
  }

  return [...guild.members.cache.values()]
    .filter(
      (member) =>
        !member.user.bot &&
        member.permissions.has(PermissionFlagsBits.ViewAuditLog),
    );
}

function enrichStaff(members, snapshot) {
  return members.map((member) => {
    const claims = snapshot.claimCounts.get(member.id) || 0;
    const messages = snapshot.messageCounts.get(member.id) || 0;
    const hasWarning = hasAnyRole(member, WARNING_ROLE_IDS);
    const starLevel = getStarLevel(member);
    const hasStar = starLevel > 0;

    return {
      member,
      claims,
      messages,
      hasWarning,
      hasStar,
      starLevel,
      active: claims > 0 || messages > 0,
    };
  });
}

function applyFilter(rows, filterKey) {
  switch (filterKey) {
    case 'star':
      return rows.filter((row) => row.hasStar);
    case 'warnings':
      return rows.filter((row) => row.hasWarning);
    case 'clean':
      return rows.filter((row) => !row.hasWarning);
    case 'active_star':
      return rows.filter((row) => row.hasStar && row.active);
    default:
      return rows;
  }
}

function sortLeaderboard(rows) {
  return [...rows].sort((a, b) => {
    if (b.claims !== a.claims) return b.claims - a.claims;
    if (b.messages !== a.messages) return b.messages - a.messages;

    return (a.member.displayName || a.member.user.username).localeCompare(
      b.member.displayName || b.member.user.username,
      undefined,
      { sensitivity: 'base' },
    );
  });
}

function getBestStarStaff(allRows) {
  const activeStars = sortLeaderboard(
    allRows.filter((row) => row.hasStar && row.active),
  );

  return activeStars[0] || null;
}

function formatTicketType(typeKey) {
  return String(typeKey || 'unknown')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDiscordTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function getCategoryName(guild, categoryId) {
  return guild.channels.cache.get(String(categoryId))?.name || String(categoryId);
}

function pageSlice(rows, requestedPage) {
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(
    Math.max(Number(requestedPage) || 0, 0),
    pageCount - 1,
  );
  const start = page * PAGE_SIZE;

  return {
    page,
    pageCount,
    rows: rows.slice(start, start + PAGE_SIZE),
    start,
  };
}

function buildPeriodRow(periodKey, filterKey, page) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`staffstats:period:${filterKey}:${page}`)
      .setPlaceholder(`Period: ${PERIODS[periodKey].label}`)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        Object.entries(PERIODS).map(([value, period]) => ({
          label: period.label,
          description: period.description,
          value,
          default: value === periodKey,
        })),
      ),
  );
}

function buildFilterRow(periodKey, filterKey, page) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`staffstats:filter:${periodKey}:${page}`)
      .setPlaceholder(`Filter: ${FILTERS[filterKey].label}`)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        Object.entries(FILTERS).map(([value, filter]) => ({
          label: filter.label,
          value,
          default: value === filterKey,
        })),
      ),
  );
}

function buildPageButtons(periodKey, filterKey, page, pageCount) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `staffstats:page:${periodKey}:${filterKey}:${Math.max(page - 1, 0)}`,
      )
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId('staffstats:noop')
      .setLabel(`Page ${page + 1}/${pageCount}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(
        `staffstats:page:${periodKey}:${filterKey}:${Math.min(
          page + 1,
          pageCount - 1,
        )}`,
      )
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
  );
}

function buildStaffSelectRow(periodKey, filterKey, page, visibleRows) {
  if (!visibleRows.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`staffstats:member:${periodKey}:${filterKey}:${page}`)
      .setPlaceholder('View a staff member on this page')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        visibleRows.map((row) => {
          const badges = [
            row.hasStar ? getStarBadge(row.starLevel) : null,
            row.hasWarning ? '⚠️' : null,
          ]
            .filter(Boolean)
            .join(' ');

          return {
            label: (row.member.displayName || row.member.user.username).slice(
              0,
              100,
            ),
            description: `${row.claims} claimed • ${row.messages} messages${
              badges ? ` • ${badges}` : ''
            }`.slice(0, 100),
            value: row.member.id,
          };
        }),
      ),
  );
}

function buildLeaderboardEmbed({
  guild,
  periodKey,
  filterKey,
  allRows,
  filteredRows,
  pageInfo,
}) {
  const period = PERIODS[periodKey];
  const filter = FILTERS[filterKey];
  const bestStar = getBestStarStaff(allRows);

  const rankingText = pageInfo.rows.length
    ? pageInfo.rows
        .map((row, index) => {
          const rank = pageInfo.start + index + 1;
          const badges = [
            row.hasStar ? getStarBadge(row.starLevel) : null,
            row.hasWarning ? '⚠️' : null,
          ]
            .filter(Boolean)
            .join('');

          return (
            `**${rank}.** <@${row.member.id}>${badges ? ` ${badges}` : ''}\n` +
            `└ **${row.claims}** ticket${row.claims === 1 ? '' : 's'} claimed • ` +
            `**${row.messages}** tracked message${row.messages === 1 ? '' : 's'}`
          );
        })
        .join('\n\n')
    : '*No staff match this filter for the selected period.*';

  const bestStarText = bestStar
    ? `${getStarBadge(bestStar.starLevel)} <@${bestStar.member.id}> — **${bestStar.claims}** claimed • **${bestStar.messages}** messages`
    : 'No active Star Management staff in this period.';

  const trackedCategories = TRACKED_CATEGORY_IDS.map((id) => {
    const category = guild.channels.cache.get(id);
    return category ? `**${category.name}** \`${id}\`` : `\`${id}\``;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📊 Staff Performance Dashboard')
    .setDescription(
      `Staff are detected automatically by the **View Audit Log** permission.\n` +
        `Leaderboard order: **tickets claimed first**, then message activity.`,
    )
    .addFields(
      {
        name: 'Period',
        value: `${period.label} • ${period.description}`,
        inline: true,
      },
      {
        name: 'Filter',
        value: filter.label,
        inline: true,
      },
      {
        name: 'Staff Shown',
        value: `${filteredRows.length}`,
        inline: true,
      },
      {
        name: '⭐ Best Active Star Staff',
        value: bestStarText,
      },
      {
        name: `🏆 Leaderboard • Page ${pageInfo.page + 1}/${pageInfo.pageCount}`,
        value: rankingText.slice(0, 1024),
      },
      {
        name: '💬 Activity Categories',
        value: trackedCategories.slice(0, 1024),
      },
    )
    .setFooter({
      text:
        '⭐ = Star Management • ⭐⭐ = Senior Star Management • ⚠️ = Warning role • Activity tracking starts from this update',
    })
    .setTimestamp();
}

async function buildLeaderboardPayload(guild, state = {}) {
  const periodKey = cleanPeriod(state.periodKey);
  const filterKey = cleanFilter(state.filterKey);

  const [members, snapshot] = await Promise.all([
    getCurrentStaffMembers(guild),
    getStaffSnapshot(guild.id, periodKey),
  ]);

  const allRows = sortLeaderboard(enrichStaff(members, snapshot));
  const filteredRows = sortLeaderboard(applyFilter(allRows, filterKey));
  const pageInfo = pageSlice(filteredRows, state.page);

  const components = [
    buildPageButtons(
      periodKey,
      filterKey,
      pageInfo.page,
      pageInfo.pageCount,
    ),
  ];

  const staffSelect = buildStaffSelectRow(
    periodKey,
    filterKey,
    pageInfo.page,
    pageInfo.rows,
  );

  if (staffSelect) components.push(staffSelect);

  components.push(
    buildPeriodRow(periodKey, filterKey, pageInfo.page),
    buildFilterRow(periodKey, filterKey, pageInfo.page),
  );

  return {
    embeds: [
      buildLeaderboardEmbed({
        guild,
        periodKey,
        filterKey,
        allRows,
        filteredRows,
        pageInfo,
      }),
    ],
    components,
  };
}

function detailNavRow(periodKey, filterKey, memberId, rows) {
  const index = rows.findIndex((row) => row.member.id === memberId);
  const previous = index > 0 ? rows[index - 1] : null;
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `staffstats:detail:${periodKey}:${filterKey}:${
          previous?.member.id || memberId
        }`,
      )
      .setEmoji('⬅️')
      .setLabel('Previous Staff')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!previous),
    new ButtonBuilder()
      .setCustomId(`staffstats:list:${periodKey}:${filterKey}:0`)
      .setLabel('Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(
        `staffstats:detail:${periodKey}:${filterKey}:${
          next?.member.id || memberId
        }`,
      )
      .setEmoji('➡️')
      .setLabel('Next Staff')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!next),
  );
}

function buildDetailEmbed({
  guild,
  row,
  rank,
  detail,
  periodKey,
  filterKey,
}) {
  const member = row.member;
  const warningRoles = getRoleMentions(member, WARNING_ROLE_IDS);
  const starRoles =
    row.starLevel === 2
      ? `⭐⭐ <@&${STAR_MANAGEMENT_ROLES.twoStar}>`
      : row.starLevel === 1
        ? `⭐ <@&${STAR_MANAGEMENT_ROLES.oneStar}>`
        : 'None';

  const claimTypeText = detail.claimTypes.length
    ? detail.claimTypes
        .map(
          (item) =>
            `• **${formatTicketType(item._id)}:** ${Number(item.count) || 0}`,
        )
        .join('\n')
    : 'No ticket claims in this period.';

  const recentClaimsText = detail.recentClaims.length
    ? detail.recentClaims
        .map(
          (claim) =>
            `• **#${claim.ticketNumber ?? '?'}** • ${formatTicketType(
              claim.typeKey,
            )} • ${formatDiscordTime(claim.claimedAt)}`,
        )
        .join('\n')
    : 'No recent claims in this period.';

  const categoryText = TRACKED_CATEGORY_IDS.map((categoryId) => {
    const count =
      detail.categoryRows.find(
        (rowData) => String(rowData._id) === String(categoryId),
      )?.count || 0;

    return `• **${getCategoryName(guild, categoryId)}:** ${count}`;
  }).join('\n');

  const channelText = detail.channelRows.length
    ? detail.channelRows
        .map((channelRow) => {
          const channel = guild.channels.cache.get(String(channelRow._id));
          const label = channel
            ? `<#${channel.id}>`
            : `#${channelRow.channelName || channelRow._id}`;

          return `• ${label} — **${channelRow.count}**`;
        })
        .join('\n')
    : 'No tracked channel messages in this period.';

  const statusBadges = [
    row.hasStar ? `${getStarBadge(row.starLevel)} Star Management` : null,
    row.hasWarning ? '⚠️ Warning role present' : null,
    row.active ? '🟢 Active' : '⚫ No tracked activity',
  ]
    .filter(Boolean)
    .join(' • ');

  return new EmbedBuilder()
    .setColor(row.hasWarning ? 0xfaa61a : row.hasStar ? 0xfee75c : 0x5865f2)
    .setAuthor({
      name: member.displayName || member.user.username,
      iconURL: member.user.displayAvatarURL({ size: 128 }),
    })
    .setTitle('👤 Staff Performance Record')
    .setDescription(
      `<@${member.id}>\n${statusBadges}\n\n` +
        `**Current filtered rank:** #${rank}`,
    )
    .addFields(
      {
        name: 'Period',
        value: `${PERIODS[periodKey].label} • ${PERIODS[periodKey].description}`,
        inline: true,
      },
      {
        name: 'Tickets Claimed',
        value: String(detail.claimTotal),
        inline: true,
      },
      {
        name: 'Tracked Messages',
        value: String(detail.messageTotal),
        inline: true,
      },
      {
        name: '⭐ Star Management Roles',
        value: starRoles,
      },
      {
        name: '⚠️ Warning Roles',
        value: warningRoles,
      },
      {
        name: '🎫 Claims by Ticket Type',
        value: claimTypeText.slice(0, 1024),
      },
      {
        name: '🕘 Recent Ticket Claims',
        value: recentClaimsText.slice(0, 1024),
      },
      {
        name: '📁 Messages by Tracked Category',
        value: categoryText.slice(0, 1024),
      },
      {
        name: '💬 Most Active Channels',
        value: channelText.slice(0, 1024),
      },
    )
    .setFooter({
      text: `Filter: ${FILTERS[filterKey].label} • Staff are identified by View Audit Log`,
    })
    .setTimestamp();
}

async function buildDetailPayload(
  guild,
  {
    periodKey,
    filterKey,
    memberId,
  },
) {
  periodKey = cleanPeriod(periodKey);
  filterKey = cleanFilter(filterKey);

  const [members, snapshot, detail] = await Promise.all([
    getCurrentStaffMembers(guild),
    getStaffSnapshot(guild.id, periodKey),
    getStaffDetail(guild.id, memberId, periodKey),
  ]);

  const allRows = sortLeaderboard(enrichStaff(members, snapshot));
  const filteredRows = sortLeaderboard(applyFilter(allRows, filterKey));
  const row =
    filteredRows.find((item) => item.member.id === memberId) ||
    allRows.find((item) => item.member.id === memberId);

  if (!row) {
    return buildLeaderboardPayload(guild, {
      periodKey,
      filterKey,
      page: 0,
    });
  }

  const effectiveRows = filteredRows.includes(row)
    ? filteredRows
    : allRows;
  const rank = effectiveRows.findIndex(
    (item) => item.member.id === memberId,
  ) + 1;

  const page = Math.max(
    0,
    Math.floor(
      Math.max(
        0,
        effectiveRows.findIndex((item) => item.member.id === memberId),
      ) / PAGE_SIZE,
    ),
  );

  const visibleRows = pageSlice(effectiveRows, page).rows;

  const components = [
    detailNavRow(periodKey, filterKey, memberId, effectiveRows),
  ];

  const staffSelect = buildStaffSelectRow(
    periodKey,
    filterKey,
    page,
    visibleRows,
  );
  if (staffSelect) components.push(staffSelect);

  components.push(
    buildPeriodRow(periodKey, filterKey, page),
    buildFilterRow(periodKey, filterKey, page),
  );

  return {
    embeds: [
      buildDetailEmbed({
        guild,
        row,
        rank,
        detail,
        periodKey,
        filterKey,
      }),
    ],
    components,
  };
}

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator,
    ),
  );
}

async function sendStaffTrackingPanel(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Use this command inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'You need **Administrator** permission to view staff tracking.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  try {
    const payload = await buildLeaderboardPayload(interaction.guild, {
      periodKey: 'weekly',
      filterKey: 'all',
      page: 0,
    });

    await interaction.editReply(payload);
  } catch (error) {
    console.error('[STAFF PANEL COMMAND ERROR]', error);

    await interaction.editReply({
      content: 'I could not load the staff performance dashboard.',
      embeds: [],
      components: [],
    });
  }
}

async function handleStaffTrackingInteraction(interaction) {
  const customId = interaction.customId;
  if (
    !customId ||
    !customId.startsWith('staffstats:')
  ) {
    return false;
  }

  if (!interaction.inGuild()) {
    return true;
  }

  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'You need **Administrator** permission to use this panel.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  if (customId === 'staffstats:noop') {
    await interaction.deferUpdate().catch(() => {});
    return true;
  }

  await interaction.deferUpdate();

  try {
    const parts = customId.split(':');
    const action = parts[1];

    if (action === 'page') {
      const [, , periodKey, filterKey, rawPage] = parts;
      const payload = await buildLeaderboardPayload(interaction.guild, {
        periodKey,
        filterKey,
        page: Number(rawPage) || 0,
      });
      await interaction.editReply(payload);
      return true;
    }

    if (action === 'list') {
      const [, , periodKey, filterKey, rawPage] = parts;
      const payload = await buildLeaderboardPayload(interaction.guild, {
        periodKey,
        filterKey,
        page: Number(rawPage) || 0,
      });
      await interaction.editReply(payload);
      return true;
    }

    if (action === 'period' && interaction.isStringSelectMenu()) {
      const [, , filterKey] = parts;
      const payload = await buildLeaderboardPayload(interaction.guild, {
        periodKey: interaction.values[0],
        filterKey,
        page: 0,
      });
      await interaction.editReply(payload);
      return true;
    }

    if (action === 'filter' && interaction.isStringSelectMenu()) {
      const [, , periodKey] = parts;
      const payload = await buildLeaderboardPayload(interaction.guild, {
        periodKey,
        filterKey: interaction.values[0],
        page: 0,
      });
      await interaction.editReply(payload);
      return true;
    }

    if (action === 'member' && interaction.isStringSelectMenu()) {
      const [, , periodKey, filterKey] = parts;
      const payload = await buildDetailPayload(interaction.guild, {
        periodKey,
        filterKey,
        memberId: interaction.values[0],
      });
      await interaction.editReply(payload);
      return true;
    }

    if (action === 'detail') {
      const [, , periodKey, filterKey, memberId] = parts;
      const payload = await buildDetailPayload(interaction.guild, {
        periodKey,
        filterKey,
        memberId,
      });
      await interaction.editReply(payload);
      return true;
    }

    await interaction.editReply({
      content: 'That staff dashboard control is no longer valid.',
      embeds: [],
      components: [],
    });
  } catch (error) {
    console.error('[STAFF PANEL INTERACTION ERROR]', error);

    await interaction.editReply({
      content: 'I could not update the staff performance dashboard.',
      embeds: [],
      components: [],
    }).catch(() => {});
  }

  return true;
}

module.exports = {
  WARNING_ROLE_IDS,
  STAR_MANAGEMENT_ROLES,
  STAR_MANAGEMENT_ROLE_IDS,
  sendStaffTrackingPanel,
  handleStaffTrackingInteraction,
};
