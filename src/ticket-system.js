const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  MessageType,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { CONFIG_PATH, getServerConfig, setServerConfig } = require('./config-store');
const {
  getTicketState,
  getTicketStatesForCreator,
  getTicketStatesForGuild,
  setTicketState,
  deleteTicketState,
} = require('./ticket-store');
const { getNextTicketNumber } = require('./ticket-counter-store');
const { recordTicketClaim } = require('./staff-tracking-store');
const { evaluateStaffGoalsForMember } = require('./staff-settings');
const {
  STAFF_ROLE_IDS,
  getHighestStaffRoleIndex,
  isStaffMember,
  isBotDeveloper,
} = require('./staff-role-hierarchy');
const {
  getAssistBypassRoleIds,
} = require('./assist-settings-store');
const {
  TRANSCRIPT_INTEGRITY_SLOT,
  signAndStoreTranscript,
} = require('./transcript-integrity');

const { ticketCreationDenial } = require('./ticket-access');
const { deleteTicketChannel } = require('./ticket-deletion-audit');
const { canMemberUseCommand, ticketDeletePermissionKey } = require('./staff-command-permissions');

const TICKET_NAME_PREFIX = 'ticket-';
const CLOSED_TICKET_NAME_PREFIX = 'closed-';
const ROLE_PAGE_SIZE = 25;
const DELETE_COUNTDOWN_SECONDS = 5;
const REPORT_STAFF_CATEGORY_ID = '1194859845426364497';
const TICKET_ALERT_ROLE_ID = '950864708066476062';
const TICKET_ACTION_BYPASS_ROLE_IDS = Object.freeze([
  '1546436573724283020',
]);
const REPORT_STAFF_PAGE_SIZE = 23;
// 22 leaves room for Back + Next + Skip/Not sure inside Discord's 25-option limit.
const MUTED_STAFF_PAGE_SIZE = 22;
const ASSIST_STAFF_PAGE_SIZE = 23;

// Fast-path authorization for newly-added assistants. Mongo remains the source
// of truth, but this prevents a just-added assistant's first message from being
// deleted if the next state read is briefly stale.
const ticketAssistantAccessCache = new Map();

const TICKET_STATE_CACHE_TTL_MS = 30 * 1000;
const STAFF_MEMBER_CACHE_TTL_MS = 60 * 1000;
const liveTicketStateCache = new Map();
const guildTicketStaffCache = new Map();
const REPORT_STAFF_SECURITY_LOG_CHANNEL_ID =
  process.env.REPORT_STAFF_SECURITY_LOG_CHANNEL_ID || '1150135578378125383';
const TRANSCRIPT_LOG_CHANNEL_ID =
  process.env.TRANSCRIPT_LOG_CHANNEL_ID || '1538580589542777055';

const TICKET_TYPES = {
  general_inquiry: {
    label: 'General Inquiry',
    slug: 'general-inquiry',
    emoji: '💬',
    requiresInGameId: false,
  },
  bug_report: {
    label: 'Bug report',
    slug: 'bug-report',
    emoji: '🐛',
    requiresInGameId: false,
  },
  cheating_report: {
    label: 'Cheating report',
    slug: 'cheating-report',
    emoji: '🚨',
    requiresInGameId: false,
  },
  muted_without_reason: {
    label: 'Muted without reason?',
    slug: 'muted-without-reason',
    emoji: '🔇',
    requiresInGameId: true,
  },
  report_staff: {
    label: 'Report Staff',
    slug: 'report-staff',
    emoji: '🛠️',
    requiresInGameId: false,
    requiresStaffSelection: true,
  },
  claim_reward: {
    label: 'Claim reward',
    slug: 'claim-reward',
    emoji: '🎁',
    requiresInGameId: true,
  },
  booster_claim: {
    label: 'Booster claim',
    slug: 'booster-claim',
    emoji: '💎',
    requiresInGameId: true,
  },
  youtuber_submission: {
    label: 'Youtuber submission',
    slug: 'youtuber-submission',
    emoji: '▶️',
    requiresInGameId: true,
  },
  clan_refund: {
    label: 'Clan skin/badge refund',
    slug: 'clan-refund',
    emoji: '🎨',
    requiresInGameId: true,
  },
  account_issues: {
    label: 'Account issues',
    slug: 'account-issues',
    emoji: '👤',
    requiresInGameId: true,
  },
  payment_issues: {
    label: 'Payment Issues',
    slug: 'payment-issues',
    emoji: '💳',
    requiresInGameId: true,
  },
  dev_test: {
    label: 'Dev test ticket',
    slug: 'dev-test',
    emoji: '🧪',
    requiresInGameId: false,
    restrictedToAdministrators: true,
    awardsClaimPoints: false,
  },
};

const YOUTUBE_RANGES = {
  '50_100': { label: '50-100', min: 50, max: 100 },
  '100_150': { label: '100-150', min: 100, max: 150 },
  '150_200': { label: '150-200', min: 150, max: 200 },
  '200_250': { label: '200-250', min: 200, max: 250 },
  '250_300': { label: '250-300', min: 250, max: 300 },
  '300_350': { label: '300-350', min: 300, max: 350 },
  '350_400': { label: '350-400', min: 350, max: 400 },
  '450_500': { label: '450-500', min: 450, max: 500 },
  '500_plus': { label: '500+', min: 500, max: Number.POSITIVE_INFINITY },
};

// Prevent two button presses at the same moment from receiving the same ticket number.
const ticketCreationQueues = new Map();

async function runTicketCreationQueued(
  guildId,
  task,
) {
  const key =
    String(
      guildId,
    );

  const previous =
    ticketCreationQueues.get(
      key,
    ) ||
    Promise.resolve();

  let releaseCurrent;

  const current =
    new Promise(
      (resolve) => {
        releaseCurrent =
          resolve;
      },
    );

  const chain =
    previous
      .catch(() => {})
      .then(
        () =>
          current,
      );

  ticketCreationQueues.set(
    key,
    chain,
  );

  await previous
    .catch(() => {});

  try {
    return await task();
  } finally {
    releaseCurrent();

    if (
      ticketCreationQueues.get(
        key,
      ) ===
      chain
    ) {
      ticketCreationQueues.delete(
        key,
      );
    }
  }
}

// Serialize claim/takeover interactions per ticket. This keeps claim history
// ordered and guarantees the first eligible staff claim is resolved before a
// takeover is processed.
const ticketClaimQueues = new Map();

async function runTicketClaimQueued(channelId, task) {
  const key = String(channelId);
  const previous =
    ticketClaimQueues.get(key) ||
    Promise.resolve();

  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });

  const chain = previous
    .catch(() => {})
    .then(() => current);

  ticketClaimQueues.set(key, chain);

  await previous.catch(() => {});

  try {
    return await task();
  } finally {
    releaseCurrent();

    if (ticketClaimQueues.get(key) === chain) {
      ticketClaimQueues.delete(key);
    }
  }
}


function getTicketButtons(
  typeKey = null,
  unmuteDecision = null,
  claimedById = null,
) {
  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'ticket_close',
          )
          .setLabel('Close')
          .setEmoji('🔒')
          .setStyle(
            ButtonStyle.Secondary,
          ),
      );

  // Report Staff is intentionally left unchanged: Close only.
  if (
    typeKey ===
    'report_staff'
  ) {
    return row;
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(
        claimedById
          ? 'ticket_assist'
          : 'ticket_claim',
      )
      .setLabel(
        claimedById
          ? 'Assist'
          : 'Claim',
      )
      .setEmoji(
        claimedById
          ? '🤝'
          : '🙋',
      )
      .setStyle(
        ButtonStyle.Primary,
      ),
    new ButtonBuilder()
      .setCustomId(
        'ticket_role',
      )
      .setLabel('Role')
      .setEmoji('🏷️')
      .setStyle(
        ButtonStyle.Success,
      ),
  );

  // Muted-without-reason still keeps its approve/reject resolution controls,
  // but now also follows the same Claim -> Assist ownership workflow.
  if (
    typeKey ===
    'muted_without_reason'
  ) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(
          'ticket_unmute_approve',
        )
        .setLabel(
          'Approved Unmute',
        )
        .setEmoji('✅')
        .setStyle(
          ButtonStyle.Success,
        )
        .setDisabled(
          Boolean(
            unmuteDecision,
          ),
        ),
      new ButtonBuilder()
        .setCustomId(
          'ticket_unmute_reject',
        )
        .setLabel(
          'Reject Unmute',
        )
        .setEmoji('❌')
        .setStyle(
          ButtonStyle.Danger,
        )
        .setDisabled(
          Boolean(
            unmuteDecision,
          ),
        ),
    );
  }

  return row;
}

function getTicketRenameButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_rename')
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
  );
}

function rowHasTicketRenameButton(row) {
  return Boolean(
    row?.components?.some(
      (component) =>
        component.customId ===
        'ticket_rename',
    ),
  );
}

function normalizeTicketChannelLabel(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(?:ticket-|closed-)\d+[\s_-]*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function getTicketChannelLabel(channel, data) {
  const currentName =
    String(
      channel?.name ||
      '',
    );

  const prefixedMatch =
    currentName.match(
      /^(?:ticket-|closed-)\d+[\s_-]*(.*)$/i,
    );

  const existing =
    prefixedMatch
      ? prefixedMatch[1]
      : currentName;

  return (
    normalizeTicketChannelLabel(
      data?.customChannelName ||
      existing,
    ) ||
    normalizeTicketChannelLabel(
      TICKET_TYPES[data?.typeKey]?.slug ||
      'support',
    )
  );
}

function buildTicketChannelName(
  prefix,
  ticketNumber,
  label,
) {
  const safeNumber =
    Number.isFinite(
      Number(
        ticketNumber,
      ),
    )
      ? Number(
          ticketNumber,
        )
      : 0;

  const safeLabel =
    normalizeTicketChannelLabel(
      label,
    ) ||
    'support';

  return (
    `${prefix}${safeNumber}_${safeLabel}`
      .slice(
        0,
        100,
      )
  );
}


function getClosedTicketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_transcript')
      .setLabel('Transcript')
      .setEmoji('📑')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_reopen')
      .setLabel('Open')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_delete')
      .setLabel('Delete')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildClosedTicketMessage(closedById) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setDescription(`🔒 **Ticket Closed by <@${closedById}>**`)
    .setFooter({ text: 'Support team ticket controls' });

  return {
    embeds: [embed],
    components: [getClosedTicketButtons()],
    allowedMentions: { users: [closedById] },
  };
}

function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Support Tickets')
    .setDescription(
      'Need help? Press **Create Ticket** below, choose what you need help with, and I will create a private support channel for you.',
    )
    .setFooter({ text: 'Support Ticket System' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_create')
      .setLabel('Create Ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

function buildTicketTypeMenu(member) {
  const canUseRestrictedTickets =
    isTicketAdministrator(
      member,
    );

  const options =
    Object.entries(
      TICKET_TYPES,
    )
      .filter(
        ([, type]) =>
          !type.restrictedToAdministrators ||
          canUseRestrictedTickets,
      )
      .map(
        ([value, type]) => ({
          label:
            type.label,
          value,
          emoji:
            type.emoji,
        }),
      );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        'ticket_create_type',
      )
      .setPlaceholder(
        'What do you need help with?',
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        options,
      );

  return {
    content:
      '**Create a ticket**\nSelect the type of ticket you want to open.',
    components: [
      new ActionRowBuilder()
        .addComponents(
          menu,
        ),
    ],
    flags:
      MessageFlags.Ephemeral,
  };
}

function buildYouTubeSubscriberMenu(creatorId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_youtube_range:${creatorId}`)
    .setPlaceholder('How many subscribers do you have?')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.entries(YOUTUBE_RANGES).map(([value, range]) => ({
        label: range.label,
        value,
      })),
    );

  return new ActionRowBuilder().addComponents(menu);
}

function getTypeInstructions(typeKey) {
  switch (typeKey) {
    case 'general_inquiry':
      return [
        '**General Inquiry**',
        'Please tell us what you need help with and include any relevant details.',
      ].join('\n');
    case 'bug_report':
      return [
        '**Please describe the bug in as much detail as possible.**',
        'Include what you were doing, what you expected to happen, what actually happened, and your device/platform if relevant.',
        '**Please attach proof** such as screenshots or a video whenever possible.',
      ].join('\n');
    case 'cheating_report':
      return [
        '**Please provide details about the cheating report.**',
        'Include the player username/ID, what you saw, when it happened, and the server/mode if known.',
        '**Proof is required where possible** — attach screenshots or video evidence.',
      ].join('\n');
    case 'muted_without_reason':
      return [
        '**Muted without reason?**',
        'First submit your **in-game user ID** using the button below. You cannot type until this is completed.',
        'After your ID is submitted, explain why you believe the mute was not justified and provide evidence such as screenshots, videos, message links, dates/times, or other useful context.',
        'If you know or suspect which staff member muted you, you can optionally select them from the staff menu below. You can also choose **Skip / Not sure**.',
      ].join('\n');
    case 'report_staff':
      return [
        '**Report Staff**',
        'Before you can type, select the staff member you are reporting from the menu below.',
        'After selecting them, provide clear information and evidence to support your report.',
        'Only server administrators and you can view this ticket.',
      ].join('\n');
    case 'claim_reward':
      return [
        '**Claim reward**',
        'Before you can type in this ticket, press **Submit In-game ID** below and enter your in-game user ID.',
        'Once submitted, you can explain which reward you are trying to claim and staff can help you.',
      ].join('\n');
    case 'booster_claim':
      return [
        '**Booster claim**',
        'Before you can type in this ticket, press **Submit In-game ID** below and enter your in-game user ID.',
        'Once submitted, staff can continue with your booster claim.',
      ].join('\n');
    case 'youtuber_submission':
      return [
        '**YouTuber submission**',
        '1. Submit your **in-game user ID** using the button below.',
        '2. Select your subscriber range from the menu below.',
        '3. A form will open asking for your YouTube channel link.',
        'You cannot type in this ticket until the required submission steps are complete.',
      ].join('\n');
    case 'clan_refund':
      return [
        '**Clan skin/badge refund**',
        'First submit your **in-game user ID** below.',
        'After that, send screenshots showing the clan skins or badges you want refunded and say which items you are requesting a refund for.',
      ].join('\n');
    case 'account_issues':
      return [
        '**Account issue**',
        'First submit your **in-game user ID** below.',
        'Once unlocked, explain exactly what is wrong with your account and include screenshots if they help.',
      ].join('\n');
    case 'payment_issues':
      return [
        '**Payment issue**',
        'First submit your **in-game user ID** below.',
        'Once unlocked, explain the payment problem and provide any relevant receipt/order reference or screenshots.',
        '**Do not post full card numbers, passwords, or other sensitive payment details.**',
      ].join('\n');
    case 'dev_test':
      return [
        '**Dev test ticket**',
        'This ticket is for testing the ticket system and staff workflow.',
        'Claim, Assist, Add Staff, Handover, close/reopen, transcript, and permission behavior can be tested here.',
        '**Claiming this ticket does not award staff claim points.**',
      ].join('\n');
    default:
      return 'Support will be with you shortly.';
  }
}


async function getReportableStaffMembers(guild, creatorId) {
  // Fetch the complete member list so the selector is not limited to whoever
  // happens to be cached after a restart.
  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[REPORT STAFF MEMBER FETCH ERROR]', error);
  }

  return [...guild.members.cache.values()]
    .filter(
      (member) =>
        !member.user.bot &&
        member.id !== creatorId &&
        member.permissions.has(PermissionFlagsBits.ViewAuditLog),
    )
    .sort((a, b) =>
      (a.displayName || a.user.username).localeCompare(
        b.displayName || b.user.username,
        undefined,
        { sensitivity: 'base' },
      ),
    );
}

function buildReportStaffSelector(creatorId, staffMembers, page = 0) {
  // Discord select menus support a maximum of 25 options. We reserve space
  // inside the menu itself for Back / Next navigation, so staff who do not fit
  // on the first list can be browsed without separate buttons.
  const pageCount = Math.max(
    1,
    Math.ceil(staffMembers.length / REPORT_STAFF_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
  const start = safePage * REPORT_STAFF_PAGE_SIZE;
  const pageMembers = staffMembers.slice(
    start,
    start + REPORT_STAFF_PAGE_SIZE,
  );

  const options = pageMembers.map((member) => ({
    label: (member.displayName || member.user.username).slice(0, 100),
    description: `@${member.user.username}`.slice(0, 100),
    value: member.id,
  }));

  // Put navigation at the BOTTOM of the menu, as requested.
  if (safePage > 0) {
    options.push({
      label: 'Back',
      description: 'View the previous staff list',
      value: `__back__:${safePage - 1}`,
      emoji: '⬅️',
    });
  }

  if (safePage < pageCount - 1) {
    options.push({
      label: 'Next',
      description: 'View more staff members',
      value: `__next__:${safePage + 1}`,
      emoji: '➡️',
    });
  }

  if (!options.length) {
    return [];
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_report_staff_select:${creatorId}:${safePage}`)
    .setPlaceholder(
      pageCount > 1
        ? `Select staff member • List ${safePage + 1}/${pageCount}`
        : 'Select the staff member you are reporting',
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return [new ActionRowBuilder().addComponents(menu)];
}


function buildMutedStaffSelector(creatorId, staffMembers, page = 0) {
  const pageCount = Math.max(
    1,
    Math.ceil(staffMembers.length / MUTED_STAFF_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
  const start = safePage * MUTED_STAFF_PAGE_SIZE;
  const pageMembers = staffMembers.slice(
    start,
    start + MUTED_STAFF_PAGE_SIZE,
  );

  const options = pageMembers.map((member) => ({
    label: (member.displayName || member.user.username).slice(0, 100),
    description: `@${member.user.username}`.slice(0, 100),
    value: member.id,
  }));

  if (safePage > 0) {
    options.push({
      label: 'Back',
      description: 'View the previous staff list',
      value: `__back__:${safePage - 1}`,
      emoji: '⬅️',
    });
  }

  if (safePage < pageCount - 1) {
    options.push({
      label: 'Next',
      description: 'View more staff members',
      value: `__next__:${safePage + 1}`,
      emoji: '➡️',
    });
  }

  // This selector is OPTIONAL for mute appeals.
  options.push({
    label: 'Skip / Not sure',
    description: 'Continue without naming a suspected staff member',
    value: '__skip__',
    emoji: '⏭️',
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_muted_staff_select:${creatorId}:${safePage}`)
    .setPlaceholder(
      pageCount > 1
        ? `Optional: who muted you? • List ${safePage + 1}/${pageCount}`
        : 'Optional: select who you think muted you',
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return [new ActionRowBuilder().addComponents(menu)];
}

function buildInGameIdActionRow(creatorId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_ingame_id:${creatorId}`)
      .setLabel('Submit In-game ID')
      .setEmoji('🆔')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

function buildReportStaffPermissionOverwrites(guild, creatorId, botId) {
  const baseMemberPermissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.AttachFiles |
    PermissionFlagsBits.EmbedLinks;

  return [
    {
      id: guild.roles.everyone.id,
      type: 0,
      deny: PermissionFlagsBits.ViewChannel,
    },
    {
      id: creatorId,
      type: 1,
      allow: baseMemberPermissions,
      deny: PermissionFlagsBits.SendMessages,
    },
    {
      id: botId,
      type: 1,
      allow:
        baseMemberPermissions |
        PermissionFlagsBits.SendMessages |
        PermissionFlagsBits.ManageChannels |
        PermissionFlagsBits.ManageMessages |
        PermissionFlagsBits.PinMessages,
    },
  ];
}

function isTicketAdministrator(member) {
  if (!member) {
    return false;
  }

  // The bot developer and Discord server owner must never be ticket-locked,
  // even if their current staff role does not expose Administrator as expected.
  if (
    isBotDeveloper(
      member,
    ) ||
    String(member.id) ===
      String(
        member.guild?.ownerId ||
        '',
      )
  ) {
    return true;
  }

  if (
    member.permissions.has(
      PermissionFlagsBits.Administrator,
    )
  ) {
    return true;
  }

  // Defensive role-level check in case GuildMember#permissions is stale while
  // roles have already updated in cache.
  return member.roles.cache.some(
    (role) =>
      role.permissions.has(
        PermissionFlagsBits.Administrator,
      ),
  );
}

function hasTicketActionBypassRole(
  member,
) {
  return Boolean(
    member?.roles?.cache &&
    TICKET_ACTION_BYPASS_ROLE_IDS.some(
      (roleId) =>
        member.roles.cache.has(
          roleId,
        ),
    )
  );
}

async function isTicketAssistManager(member) {
  if (
    isTicketAdministrator(
      member,
    ) ||
    hasTicketActionBypassRole(
      member,
    )
  ) {
    return true;
  }

  const roleIds =
    await getAssistBypassRoleIds(
      member?.guild?.id,
    ).catch((error) => {
      console.error(
        '[TICKET ASSIST BYPASS ROLE READ ERROR]',
        error,
      );
      return [];
    });

  return roleIds.some((roleId) =>
    member?.roles?.cache?.has(
      roleId,
    ),
  );
}

function assistantCacheForChannel(
  channelId,
) {
  const key =
    String(
      channelId,
    );

  if (
    !ticketAssistantAccessCache.has(
      key,
    )
  ) {
    ticketAssistantAccessCache.set(
      key,
      new Set(),
    );
  }

  return ticketAssistantAccessCache.get(
    key,
  );
}

function cacheTicketAssistants(
  channelId,
  staffIds,
) {
  const cache =
    assistantCacheForChannel(
      channelId,
    );

  for (
    const staffId of
    staffIds || []
  ) {
    cache.add(
      String(
        staffId,
      ),
    );
  }
}

function removeCachedTicketAssistant(
  channelId,
  staffId,
) {
  const cache =
    ticketAssistantAccessCache.get(
      String(
        channelId,
      ),
    );

  if (!cache) {
    return;
  }

  cache.delete(
    String(
      staffId,
    ),
  );

  if (
    cache.size === 0
  ) {
    ticketAssistantAccessCache.delete(
      String(
        channelId,
      ),
    );
  }
}

function hasCachedTicketAssistant(
  channelId,
  staffId,
) {
  return Boolean(
    ticketAssistantAccessCache
      .get(
        String(
          channelId,
        ),
      )
      ?.has(
        String(
          staffId,
        ),
      ),
  );
}

function setLiveTicketStateCache(channelId, data) {
  liveTicketStateCache.set(
    String(channelId),
    {
      data,
      cachedAt: Date.now(),
    },
  );
}

function getLiveTicketStateCache(channelId) {
  const key = String(channelId);
  const cached = liveTicketStateCache.get(key);

  if (!cached) {
    return null;
  }

  if (
    Date.now() - cached.cachedAt >
    TICKET_STATE_CACHE_TTL_MS
  ) {
    liveTicketStateCache.delete(key);
    return null;
  }

  return cached.data;
}

function getCachedGuildTicketStaff(guildId) {
  const key = String(guildId);
  const cached = guildTicketStaffCache.get(key);

  if (!cached) {
    return null;
  }

  if (
    Date.now() - cached.cachedAt >
    STAFF_MEMBER_CACHE_TTL_MS
  ) {
    guildTicketStaffCache.delete(key);
    return null;
  }

  return cached.members;
}

function setCachedGuildTicketStaff(guildId, members) {
  guildTicketStaffCache.set(
    String(guildId),
    {
      members,
      cachedAt: Date.now(),
    },
  );
}

function isTicketStaffMember(member) {
  return Boolean(
    member &&
    !member.user?.bot &&
    (
      isStaffMember(
        member,
      ) ||
      hasTicketActionBypassRole(
        member,
      ) ||
      isTicketAdministrator(
        member,
      )
    )
  );
}

async function wasTicketCreatedByStaff(
  guild,
  data,
) {
  if (
    typeof data?.creatorWasStaff ===
      'boolean'
  ) {
    return data.creatorWasStaff;
  }

  const creatorId =
    String(
      data?.creatorId ||
      '',
    );

  if (!creatorId) {
    return false;
  }

  const creatorMember =
    guild.members.cache.get(
      creatorId,
    ) ||
    (await guild.members
      .fetch(
        creatorId,
      )
      .catch(() => null));

  return isTicketStaffMember(
    creatorMember,
  );
}

async function getTicketStaffMembers(
  guild,
  creatorId = null,
) {
  let staffMembers =
    getCachedGuildTicketStaff(
      guild.id,
    );

  if (!staffMembers) {
    if (
      guild.members.cache.size <
      2
    ) {
      await guild.members
        .fetch()
        .catch((error) => {
          console.error(
            '[TICKET STAFF FETCH ERROR]',
            error,
          );
        });
    }

    staffMembers =
      [
        ...guild.members.cache.values(),
      ]
        .filter(
          (member) =>
            isTicketStaffMember(
              member,
            ),
        )
        .sort((a, b) => {
          const levelDifference =
            getHighestStaffRoleIndex(b) -
            getHighestStaffRoleIndex(a);

          if (levelDifference) {
            return levelDifference;
          }

          return (
            a.displayName ||
            a.user.username
          ).localeCompare(
            b.displayName ||
            b.user.username,
            undefined,
            {
              sensitivity: 'base',
            },
          );
        });

    setCachedGuildTicketStaff(
      guild.id,
      staffMembers,
    );
  }

  return staffMembers.filter(
    (member) =>
      String(member.id) !==
      String(creatorId || ''),
  );
}


async function setTicketStaffTyping(
  channel,
  staffId,
  enabled,
  reason,
) {
  const id =
    String(
      staffId,
    );

  const member =
    channel.guild.members.cache.get(
      id,
    ) ||
    (await channel.guild.members
      .fetch(
        id,
      )
      .catch(() => null));

  const administrator =
    isTicketAdministrator(
      member,
    );

  // Discord Administrators are never ticket-locked. This deliberately wins
  // over Claim / Assist / Handover ownership rules.
  const shouldEnable =
    administrator
      ? true
      : Boolean(
          enabled,
        );

  const overwrite = {
    ViewChannel: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
    AddReactions: true,
    UseApplicationCommands: true,
    SendMessages:
      shouldEnable,
  };

  // First try the normal overwrite edit. This should clear the old member-level
  // SendMessages deny when enabled=true.
  await channel.permissionOverwrites.edit(
    member || id,
    overwrite,
    { type: OverwriteType.Member, reason },
  );

  if (
    !shouldEnable ||
    !member
  ) {
    return;
  }

  // Verify the effective permission. If Discord still resolves SendMessages as
  // denied, rebuild the member overwrite from scratch. This covers stale /
  // inherited member overwrite states from tickets created before this fix.
  let effective =
    channel.permissionsFor(
      member,
    );

  if (
    effective?.has(
      PermissionFlagsBits.SendMessages,
    )
  ) {
    return;
  }

  console.warn(
    `[TICKET ASSIST PERMISSION RETRY] ${id} still cannot SendMessages in ${channel.id}; rebuilding member overwrite.`,
  );

  await channel.permissionOverwrites
    .delete(
      member,
      `${reason} - clearing stale ticket staff deny`,
    )
    .catch((error) => {
      console.error(
        '[TICKET ASSIST OVERWRITE DELETE RETRY ERROR]',
        error,
      );
    });

  await channel.permissionOverwrites.edit(
    member,
    overwrite,
    { type: OverwriteType.Member, reason: `${reason} - rebuilt assistant access` },
  );

  effective =
    channel.permissionsFor(
      member,
    );

  if (
    !effective?.has(
      PermissionFlagsBits.SendMessages,
    )
  ) {
    throw new Error(
      `Discord still reports SendMessages denied for assistant ${id} after rebuilding the member overwrite.`,
    );
  }
}

async function ensureTicketSpeakerPermission(
  channel,
  staffId,
  reason,
) {
  const id =
    String(
      staffId ||
      '',
    );

  if (!id) {
    return false;
  }

  const currentOverwrite =
    channel.permissionOverwrites.cache.get(
      id,
    );

  const alreadyAllowed =
    Boolean(
      currentOverwrite
        ?.allow
        ?.has(
          PermissionFlagsBits.SendMessages,
        ) &&
      !currentOverwrite
        ?.deny
        ?.has(
          PermissionFlagsBits.SendMessages,
        ),
    );

  if (alreadyAllowed) {
    return false;
  }

  await setTicketStaffTyping(
    channel,
    id,
    true,
    reason,
  );

  return true;
}

async function applyTicketStaffTypingState(
  channel,
  data,
  reason =
    'Ticket staff typing state synchronized',
) {
  if (
    !data ||
    data.typeKey ===
      'report_staff'
  ) {
    return;
  }

  const allowedIds = [
    ...new Set([
      data.claimedById
        ? String(data.claimedById)
        : null,
      ...(
        Array.isArray(data.assistStaffIds)
          ? data.assistStaffIds.map(String)
          : []
      ),
    ].filter(Boolean)),
  ];

  await Promise.all(
    allowedIds.map(
      async (staffId) => {
        await setTicketStaffTyping(
          channel,
          staffId,
          true,
          reason,
        );

        if (
          staffId !==
          String(data.claimedById || '')
        ) {
          cacheTicketAssistants(
            channel.id,
            [staffId],
          );
        }
      },
    ),
  );
}


function getLastClaimOwnerId(
  data,
) {
  if (
    data?.claimedById
  ) {
    return String(
      data.claimedById,
    );
  }

  const history =
    Array.isArray(
      data?.claimHistory,
    )
      ? data.claimHistory
      : [];

  for (
    let index =
      history.length - 1;
    index >= 0;
    index -= 1
  ) {
    const userId =
      history[index]
        ?.userId;

    if (userId) {
      return String(
        userId,
      );
    }
  }

  return null;
}

async function inferLegacyAssistantsFromOverwrites(
  channel,
  data,
) {
  const inferred =
    new Set();

  const ownerId =
    getLastClaimOwnerId(
      data,
    );

  const creatorId =
    String(
      data?.creatorId ||
      '',
    );

  const botId =
    String(
      channel.client.user?.id ||
      '',
    );

  for (
    const overwrite of
    channel.permissionOverwrites.cache.values()
  ) {
    // Discord permission overwrite type 1 = Member.
    if (
      Number(
        overwrite.type,
      ) !==
        1 ||
      !overwrite.allow.has(
        PermissionFlagsBits.SendMessages,
      ) ||
      overwrite.deny.has(
        PermissionFlagsBits.SendMessages,
      )
    ) {
      continue;
    }

    const memberId =
      String(
        overwrite.id,
      );

    if (
      memberId ===
        creatorId ||
      memberId ===
        botId ||
      memberId ===
        String(
          ownerId ||
          '',
        )
    ) {
      continue;
    }

    const member =
      channel.guild.members.cache.get(
        memberId,
      ) ||
      (await channel.guild.members
        .fetch(
          memberId,
        )
        .catch(() => null));

    if (
      !member ||
      !isTicketStaffMember(
        member,
      ) ||
      isTicketAdministrator(
        member,
      )
    ) {
      continue;
    }

    inferred.add(
      memberId,
    );
  }

  return [
    ...inferred,
  ];
}

async function restoreOneTicketRuntimeState(
  channel,
  storedState,
) {
  const base =
    getTicketData(
      channel,
    );

  if (
    !base ||
    base.typeKey ===
      'report_staff'
  ) {
    return {
      restored:
        false,
      repairedPermissions:
        0,
      recoveredAssistants:
        0,
    };
  }

  const live = {
    ...base,
    ...(storedState || {}),
    claimedById:
      storedState?.claimedById ||
      base.claimedById ||
      null,
    claimHistory:
      Array.isArray(
        storedState?.claimHistory,
      )
        ? storedState.claimHistory
        : base.claimHistory,
    assistStaffIds:
      Array.isArray(
        storedState?.assistStaffIds,
      )
        ? storedState.assistStaffIds.map(
            String,
          )
        : [],
    assistHistory:
      Array.isArray(
        storedState?.assistHistory,
      )
        ? storedState.assistHistory
        : [],
    handoverHistory:
      Array.isArray(
        storedState?.handoverHistory,
      )
        ? storedState.handoverHistory
        : [],
    pendingHandover:
      storedState?.pendingHandover ||
      null,
    controlMessageId:
      storedState?.controlMessageId ||
      base.controlMessageId ||
      null,
  };

  let stateChanged =
    false;

  const recoveredOwnerId =
    getLastClaimOwnerId(
      live,
    );

  if (
    !live.claimedById &&
    recoveredOwnerId
  ) {
    live.claimedById =
      recoveredOwnerId;

    stateChanged =
      true;
  }

  const assistants =
    new Set(
      Array.isArray(
        live.assistStaffIds,
      )
        ? live.assistStaffIds.map(
            String,
          )
        : [],
    );

  // Migration path for assistants that were added before ticket-store.js
  // persisted assistStaffIds. Their Discord member overwrite survives a bot
  // reboot, so recover those IDs and write them back to MongoDB.
  const legacyAssistants =
    await inferLegacyAssistantsFromOverwrites(
      channel,
      live,
    );

  let recoveredAssistants =
    0;

  for (
    const staffId of
    legacyAssistants
  ) {
    if (
      assistants.has(
        staffId,
      )
    ) {
      continue;
    }

    assistants.add(
      staffId,
    );

    recoveredAssistants +=
      1;

    stateChanged =
      true;
  }

  live.assistStaffIds =
    [
      ...assistants,
    ];

  setLiveTicketStateCache(
    channel.id,
    live,
  );

  cacheTicketAssistants(
    channel.id,
    live.assistStaffIds,
  );

  if (stateChanged) {
    await setTicketState(
      channel.id,
      {
        ...live,
        updatedAt:
          new Date().toISOString(),
        updateReason:
          'Recovered ticket ownership/assistant state after bot restart',
      },
    ).catch((error) => {
      console.error(
        `[TICKET REBOOT STATE MIGRATION ERROR] ${channel.id}`,
        error,
      );
    });
  }

  // Closed tickets stay closed. Their saved owner/assistant state remains in
  // MongoDB and will be reapplied by the normal Reopen flow later.
  const isClosed =
    Boolean(
      live.closedAt,
    ) ||
    channel.name.startsWith(
      CLOSED_TICKET_NAME_PREFIX,
    );

  if (isClosed) {
    return {
      restored:
        true,
      repairedPermissions:
        0,
      recoveredAssistants,
    };
  }

  // Repair the creator's effective permission on existing open tickets.
  // This is a no-op when the saved member overwrite is already correct.
  await setCreatorTyping(
    channel,
    live.creatorId,
    shouldCreatorBeUnlocked(
      live,
    ),
    'Restored ticket creator access after bot restart',
  ).catch((error) => {
    console.error(
      `[TICKET REBOOT CREATOR PERMISSION ERROR] ${channel.id}/${live.creatorId}`,
      error,
    );
  });

  // Refresh existing open ticket messages during startup so controls added by
  // newer deployments (including Rename) also appear on older active tickets.
  await refreshTicketControlMessage(
    channel,
    live,
  ).catch((error) => {
    console.error(
      `[TICKET REBOOT CONTROL REFRESH ERROR] ${channel.id}`,
      error,
    );
  });

  const speakerIds =
    [
      ...new Set([
        live.claimedById
          ? String(
              live.claimedById,
            )
          : null,
        ...live.assistStaffIds,
      ].filter(Boolean)),
    ];

  let repairedPermissions =
    0;

  // Keep the startup pass rate-limit friendly. Most tickets will need zero
  // Discord API calls because member overwrites themselves survive a reboot.
  for (
    const staffId of
    speakerIds
  ) {
    const changed =
      await ensureTicketSpeakerPermission(
        channel,
        staffId,
        'Restored ticket claimer/assistant access after bot restart',
      ).catch((error) => {
        console.error(
          `[TICKET REBOOT PERMISSION RESTORE ERROR] ${channel.id}/${staffId}`,
          error,
        );

        return false;
      });

    if (changed) {
      repairedPermissions +=
        1;
    }
  }

  return {
    restored:
      true,
    repairedPermissions,
    recoveredAssistants,
  };
}

function assertTicketRuntimeHelpers() {
  const helpers = {
    runTicketCreationQueued:
      typeof runTicketCreationQueued,
    mergeOverwrite:
      typeof mergeOverwrite,
    buildTicketPermissionOverwrites:
      typeof buildTicketPermissionOverwrites,
    createTicket:
      typeof createTicket,
    getLiveTicketData:
      typeof getLiveTicketData,
    setTicketStaffTyping:
      typeof setTicketStaffTyping,
    showRoleMenu:
      typeof showRoleMenu,
    getRoleContext:
      typeof getRoleContext,
    canActorManageMember:
      typeof canActorManageMember,
    getAssignableTicketRoles:
      typeof getAssignableTicketRoles,
    openInGameIdModal:
      typeof openInGameIdModal,
    handleInGameIdModal:
      typeof handleInGameIdModal,
    updateInGameIdControlState:
      typeof updateInGameIdControlState,
    refreshClickedTicketControlMessage:
      typeof refreshClickedTicketControlMessage,
    refreshTicketControlMessage:
      typeof refreshTicketControlMessage,
    claimTicketUnlocked:
      typeof claimTicketUnlocked,
    isStaffForTicket:
      typeof isStaffForTicket,
    isTicketStaffMember:
      typeof isTicketStaffMember,
  };

  const missing =
    Object.entries(
      helpers,
    )
      .filter(
        ([, type]) =>
          type !==
          'function',
      )
      .map(
        ([name]) =>
          name,
      );

  if (
    missing.length
  ) {
    throw new Error(
      `Ticket runtime helper self-check failed: ${missing.join(', ')}`,
    );
  }

  console.log(
    '[TICKET SELF CHECK] Critical ticket runtime helpers are available.',
  );

  return true;
}

async function restoreTicketRuntimeState(
  client,
) {
  assertTicketRuntimeHelpers();

  let ticketCount =
    0;

  let repairedPermissions =
    0;

  let recoveredAssistants =
    0;

  for (
    const guild of
    client.guilds.cache.values()
  ) {
    const storedStates =
      await getTicketStatesForGuild(
        guild.id,
      ).catch((error) => {
        console.error(
          `[TICKET REBOOT STATE LOAD ERROR] ${guild.id}`,
          error,
        );

        return [];
      });

    const stateByChannelId =
      new Map(
        storedStates.map(
          (state) => [
            String(
              state.channelId,
            ),
            state,
          ],
        ),
      );

    const ticketChannels =
      [
        ...guild.channels.cache.values(),
      ].filter(
        (channel) =>
          Boolean(
            getTicketData(
              channel,
            ),
          ),
      );

    // Small batches prevent a guild with many old tickets from creating a
    // large burst of MongoDB/member/permission requests at startup.
    const BATCH_SIZE =
      4;

    for (
      let index =
        0;
      index <
      ticketChannels.length;
      index +=
        BATCH_SIZE
    ) {
      const batch =
        ticketChannels.slice(
          index,
          index +
            BATCH_SIZE,
        );

      const results =
        await Promise.all(
          batch.map(
            async (channel) => {
              let stored =
                stateByChannelId.get(
                  String(
                    channel.id,
                  ),
                ) ||
                null;

              if (!stored) {
                stored =
                  await getTicketState(
                    channel.id,
                  ).catch(
                    () => null,
                  );
              }

              return restoreOneTicketRuntimeState(
                channel,
                stored,
              );
            },
          ),
        );

      for (
        const result of
        results
      ) {
        if (
          !result?.restored
        ) {
          continue;
        }

        ticketCount +=
          1;

        repairedPermissions +=
          Number(
            result.repairedPermissions ||
            0,
          );

        recoveredAssistants +=
          Number(
            result.recoveredAssistants ||
            0,
          );
      }
    }
  }

  console.log(
    `[TICKET REBOOT RESTORE] Restored ${ticketCount} ticket(s), ` +
      `repaired ${repairedPermissions} speaker permission(s), ` +
      `recovered ${recoveredAssistants} legacy assistant(s).`,
  );

  return {
    ticketCount,
    repairedPermissions,
    recoveredAssistants,
  };
}

async function deletePinNotification(
  channel,
  pinnedMessage,
  pinStartedAt,
) {
  const retryDelays = [
    250,
    700,
    1400,
    2500,
    4000,
  ];

  let deletedCount = 0;

  for (
    const delay of
    retryDelays
  ) {
    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          delay,
        ),
    );

    const recent =
      await channel.messages
        .fetch({
          limit: 25,
        })
        .catch(() => null);

    if (!recent) {
      continue;
    }

    for (
      const message of
      recent.values()
    ) {
      if (
        message.id ===
          pinnedMessage.id ||
        message.type !==
          MessageType.ChannelPinnedMessage ||
        message.createdTimestamp <
          pinStartedAt - 3000
      ) {
        continue;
      }

      const deleted =
        await message
          .delete()
          .then(
            () => true,
          )
          .catch((error) => {
            console.error(
              '[TICKET PIN NOTICE DELETE ERROR]',
              error,
            );

            return false;
          });

      if (deleted) {
        deletedCount += 1;
      }
    }

    if (
      deletedCount >
      0
    ) {
      break;
    }
  }

  if (
    deletedCount === 0
  ) {
    console.warn(
      `[TICKET PIN NOTICE] No pin system message found to delete for ${pinnedMessage.id} in ${channel.id}.`,
    );
  }
}


async function pinTicketControlMessage(
  message,
) {
  const pinStartedAt =
    Date.now();

  try {
    await message.pin(
      'Pinned ticket controls',
    );

    deletePinNotification(
      message.channel,
      message,
      pinStartedAt,
    ).catch((error) => {
      console.error(
        '[TICKET PIN NOTICE BACKGROUND CLEANUP ERROR]',
        error,
      );
    });
  } catch (error) {
    console.error(
      '[TICKET CONTROL PIN ERROR]',
      error,
    );
  }
}

async function findTicketControlMessage(
  channel,
  data,
) {
  if (
    data?.controlMessageId
  ) {
    const stored =
      await channel.messages
        .fetch(
          data.controlMessageId,
        )
        .catch(() => null);

    if (stored) {
      return stored;
    }
  }

  const pinned =
    await channel.messages
      .fetchPinned()
      .catch(() => null);

  if (pinned) {
    const match =
      pinned.find(
        (message) =>
          message.author?.id ===
            channel.client.user.id &&
          (
            messageHasButton(
              message,
              'ticket_claim',
            ) ||
            messageHasButton(
              message,
              'ticket_assist',
            ) ||
            (
              data?.typeKey ===
                'report_staff' &&
              messageHasButton(
                message,
                'ticket_close',
              )
            )
          ),
      );

    if (match) {
      return match;
    }
  }

  const recent =
    await channel.messages
      .fetch({
        limit: 50,
      })
      .catch(() => null);

  return (
    recent?.find(
      (message) =>
        message.author?.id ===
          channel.client.user.id &&
        (
          messageHasButton(
            message,
            'ticket_claim',
          ) ||
          messageHasButton(
            message,
            'ticket_assist',
          )
        ),
    ) ||
    null
  );
}

async function refreshClickedTicketControlMessage(
  interaction,
  data,
) {
  const message =
    interaction?.message;

  if (
    !message ||
    !data ||
    data.typeKey ===
      'report_staff'
  ) {
    return false;
  }

  const remainingRows =
    message.components
      .slice(
        1,
      )
      .filter(
        (row) =>
          !rowHasTicketRenameButton(
            row,
          ),
      );

  await message.edit({
    components: [
      getTicketButtons(
        data.typeKey,
        data.unmuteDecision,
        data.claimedById,
      ),
      ...remainingRows,
      getTicketRenameButtonRow(),
    ],
  });

  return true;
}

async function refreshTicketControlMessage(
  channel,
  data,
) {
  if (
    !data ||
    data.typeKey ===
      'report_staff'
  ) {
    return;
  }

  const message =
    await findTicketControlMessage(
      channel,
      data,
    );

  if (!message) {
    console.warn(
      `[TICKET CONTROL] Could not find control message in ${channel.id}.`,
    );
    return;
  }

  const remainingRows =
    message.components
      .slice(1)
      .filter(
        (row) =>
          !rowHasTicketRenameButton(
            row,
          ),
      );

  await message.edit({
    components: [
      getTicketButtons(
        data.typeKey,
        data.unmuteDecision,
        data.claimedById,
      ),
      ...remainingRows,
      getTicketRenameButtonRow(),
    ],
  });
}

function getBottomPositionForCategory(category) {
  const positions = [
    category.rawPosition,
    ...category.children.cache.map((channel) => channel.rawPosition),
  ];

  return Math.max(...positions) + 1;
}

function buildReportStaffGuidelinesEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(
      '⚠️ Report Staff Guidelines',
    )
    .setDescription(
      [
        'Your report must relate to activity within **this server** and comply with the **game guidelines**.',
        'We do not handle disputes, incidents, or business involving any other server, even when that server is related to the same game.',
      ].join(
        '\n\n',
      ),
    );
}

function buildTicketWelcome(ticketNumber, creator, typeKey, options = {}) {
  const type = TICKET_TYPES[typeKey] || { label: 'Support', emoji: '🎫' };
  const embed = new EmbedBuilder()
    .setColor(0x00d166)
    .setTitle(`${type.emoji || '🎫'} ${type.label}`)
    .setDescription(`${getTypeInstructions(typeKey)}\n\nTo close this ticket use the 🔒 **Close** button below.`)
    .setFooter({
      text: `Ticket #${ticketNumber} • Created by ${creator.username}`,
      iconURL: creator.displayAvatarURL(),
    });

  const components = [
    getTicketButtons(
      typeKey,
      options.unmuteDecision || null,
      options.claimedById || null,
    ),
  ];

  if (TICKET_TYPES[typeKey]?.requiresInGameId) {
    components.push(buildInGameIdActionRow(creator.id));
  }

  if (typeKey === 'youtuber_submission') {
    components.push(buildYouTubeSubscriberMenu(creator.id));
  }

  if (typeKey === 'muted_without_reason' && (options.reportStaffMembers || []).length) {
    components.push(
      ...buildMutedStaffSelector(
        creator.id,
        options.reportStaffMembers || [],
        0,
      ),
    );
  }

  if (typeKey === 'report_staff') {
    components.push(
      ...buildReportStaffSelector(
        creator.id,
        options.reportStaffMembers || [],
        0,
      ),
    );
  } else {
    components.push(
      getTicketRenameButtonRow(),
    );
  }

  return {
    content: `<@${creator.id}> Welcome`,
    embeds: [embed],
    components,
    allowedMentions: { users: [creator.id] },
  };
}

async function getGuildConfig(guild) {
  if (!guild) return null;

  let config;
  try {
    config = await getServerConfig(guild.id);
  } catch (error) {
    console.error(`[CONFIG READ ERROR] Failed to read ${CONFIG_PATH}:`, error);
    return null;
  }

  if (!config) return null;

  const category = await guild.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return null;

  return config;
}

function hasSetupPermission(member) {
  return Boolean(
    member?.permissions.has(PermissionFlagsBits.Administrator) ||
      member?.permissions.has(PermissionFlagsBits.ManageChannels),
  );
}

function canActorGiveRole(guild, actor, role) {
  if (!actor?.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  if (guild.ownerId === actor.id) return true;
  return actor.roles.highest.comparePositionTo(role) > 0;
}

function canBotGiveRole(botMember, role) {
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  return botMember.roles.highest.comparePositionTo(role) > 0;
}

async function saveGuildConfig(guild, category, roleIds, actor) {
  const saved = await setServerConfig(guild.id, {
    categoryId: category.id,
    roleIds,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.id,
  });

  console.log(
    `[CONFIG] Saved ticket config for guild ${guild.id} to ${CONFIG_PATH} ` +
      `(category=${saved.categoryId}, roles=${saved.roleIds.length}).`,
  );

  return saved;
}

function buildCategorySetupMessage(panelChannelId) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket_setup_category:${panelChannelId}`)
    .setPlaceholder('Select the ticket category')
    .setChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  return {
    content:
      '**Ticket setup — Step 1 of 2**\nSelect the category where new ticket channels should be created.',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  };
}

function buildRoleSetupMessage(categoryId, panelChannelId) {
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(`ticket_setup_roles:${categoryId}:${panelChannelId}`)
    .setPlaceholder('Select the roles staff may give in tickets')
    .setMinValues(1)
    .setMaxValues(25);

  return {
    content:
      '**Ticket setup — Step 2 of 2**\nSelect every role that should be available from the **Role** button inside tickets. You can select multiple roles.',
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

async function sendPanelAsNewMessage(channel) {
  if (!channel?.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('Panel target is not a sendable text channel.');
  }

  return channel.send(buildPanelMessage());
}

async function sendTicketPanelCommand(interaction, forceSetup = false) {
  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);

  if (!hasSetupPermission(member)) {
    await interaction.reply({
      content: 'You need **Manage Channels** to use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = forceSetup ? null : await getGuildConfig(guild);

  if (!config) {
    await interaction.reply(buildCategorySetupMessage(interaction.channelId));
    return;
  }

  try {
    await sendPanelAsNewMessage(interaction.channel);
    await interaction.reply({
      content: `✅ Ticket panel sent as a new message in <#${interaction.channelId}>.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('[TICKET PANEL SEND ERROR]', error);
    await interaction.reply({
      content: 'I could not send the ticket panel in this channel. Check my **Send Messages** and **Embed Links** permissions.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleSetupCategory(interaction) {
  const [, panelChannelId] = interaction.customId.split(':');
  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);

  if (!hasSetupPermission(member)) {
    await interaction.reply({
      content: 'You need **Manage Channels** to configure tickets.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: 'You also need **Manage Roles** to choose which roles can be given from tickets.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const categoryId = interaction.values[0];
  const category = await guild.channels.fetch(categoryId).catch(() => null);

  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.update({
      content: 'That category no longer exists. Run `/ticket-panel` again.',
      components: [],
    });
    return;
  }

  await interaction.update(buildRoleSetupMessage(categoryId, panelChannelId));
}

async function handleSetupRoles(interaction) {
  const [, categoryId, panelChannelId] = interaction.customId.split(':');
  const guild = interaction.guild;
  const actor = await guild.members.fetch(interaction.user.id).catch(() => null);

  if (!hasSetupPermission(actor) || !actor.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: 'You need **Manage Channels** and **Manage Roles** to finish ticket setup.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await interaction.update({
      content: 'The selected category no longer exists. Run `/ticket-panel` again.',
      components: [],
    });
    return;
  }

  const botMember = guild.members.me || (await guild.members.fetchMe());

  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.update({
      content: 'I need **Manage Channels** before this ticket system can create/manage ticket channels.',
      components: [],
    });
    return;
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.update({
      content: 'I need **Manage Roles** before roles can be assigned from tickets.',
      components: [],
    });
    return;
  }

  const selectedRoleIds = [...new Set(interaction.values)];
  const validRoleIds = [];
  const ignoredRoleNames = [];

  for (const roleId of selectedRoleIds) {
    const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));

    const valid =
      role &&
      role.id !== guild.roles.everyone.id &&
      !role.managed &&
      canActorGiveRole(guild, actor, role) &&
      canBotGiveRole(botMember, role);

    if (valid) validRoleIds.push(role.id);
    else if (role) ignoredRoleNames.push(role.name);
  }

  if (!validRoleIds.length) {
    await interaction.update({
      content:
        'None of those roles can be assigned by both you and the bot. Make sure the bot role is above the roles you want to give, then run `/ticket-panel` again.',
      components: [],
    });
    return;
  }

  try {
    await saveGuildConfig(guild, category, validRoleIds, actor);
  } catch (error) {
    console.error('[TICKET CONFIG SAVE ERROR]', error);
    await interaction.update({
      content: `I could not save the ticket configuration to the local config file. Check that \`${CONFIG_PATH}\` is writable.`,
      components: [],
    });
    return;
  }

  const panelChannel = await guild.channels.fetch(panelChannelId).catch(() => null);
  if (!panelChannel?.isTextBased() || typeof panelChannel.send !== 'function') {
    await interaction.update({
      content: '✅ Setup saved, but the channel where `/ticket-panel` was used is no longer available.',
      components: [],
    });
    return;
  }

  try {
    await sendPanelAsNewMessage(panelChannel);
  } catch (error) {
    console.error('[TICKET PANEL SEND ERROR]', error);
    await interaction.update({
      content:
        '✅ Setup saved, but I could not send the panel. Check my **Send Messages** and **Embed Links** permissions in the panel channel.',
      components: [],
    });
    return;
  }

  const roleMentions = validRoleIds.map((id) => `<@&${id}>`).join(', ');
  const ignoredText = ignoredRoleNames.length
    ? `\nIgnored roles I cannot assign: ${ignoredRoleNames.map((name) => `**${name}**`).join(', ')}`
    : '';

  await interaction.update({
    content:
      `✅ **Ticket setup complete.**\n` +
      `Ticket category: <#${category.id}>\n` +
      `Allowed ticket roles: ${roleMentions}\n` +
      `The ticket panel was sent as a new message in <#${panelChannel.id}>.${ignoredText}`,
    components: [],
    allowedMentions: { parse: [] },
  });
}

function initialSubmissionState(typeKey) {
  return {
    inGameIdStatus: TICKET_TYPES[typeKey]?.requiresInGameId ? 'pending' : 'na',
    youtubeStatus: typeKey === 'youtuber_submission' ? 'pending' : 'na',
    staffSelectionStatus:
      typeKey === 'report_staff'
        ? 'pending'
        : typeKey === 'muted_without_reason'
          ? 'optional'
          : 'na',
    reportedStaffId: null,
    unmuteDecision: null,
    unmuteDecisionBy: null,
    closedById: null,
    closedAt: null,
    claimHistory: [],
    assistStaffIds: [],
    assistHistory: [],
    handoverHistory: [],
    pendingHandover: null,
    controlMessageId: null,
    customChannelName: null,
  };
}

function makeTicketTopic(ticketNumber, typeKey, creatorId) {
  // Keep the channel topic IMMUTABLE after creation.
  //
  // Claim/form state is stored in MongoDB. Editing the channel topic uses the
  // same Modify Channel API route as renaming the ticket, which can cause the
  // ticket name to be delayed by Discord's rate limiting.
  return [
    `Ticket #${ticketNumber}`,
    `Type=${typeKey}`,
    `Created by <@${creatorId}>`,
  ].join(' | ');
}

function getTicketData(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return null;

  // The immutable ticket topic is the identity marker. Staff-renamed tickets
  // no longer need to retain ticket-{number}_ in their visible channel name.
  const topic = channel.topic || '';
  const numberMatch = topic.match(/Ticket #(\d+)/i);
  const typeMatch = topic.match(/(?:^|\|)\s*Type=([a-z_]+)/i);
  const creatorMatch = topic.match(/Created by <@!?(\d+)>/i);
  const igMatch = topic.match(/(?:^|\|)\s*IG=(pending|done|na)/i);
  const ytMatch = topic.match(/(?:^|\|)\s*YT=(pending|done|na)/i);
  const claimedMatch = topic.match(/Ticket claimed by <@!?(\d+)>/i);

  if (
    !creatorMatch ||
    !numberMatch
  ) {
    return null;
  }

  const typeKey = typeMatch?.[1] || 'bug_report';
  const fallbackState = initialSubmissionState(typeKey);

  return {
    number: numberMatch ? Number(numberMatch[1]) : null,
    typeKey,
    creatorId: creatorMatch[1],
    creatorWasStaff: null,
    inGameIdStatus: igMatch?.[1]?.toLowerCase() || fallbackState.inGameIdStatus,
    youtubeStatus: ytMatch?.[1]?.toLowerCase() || fallbackState.youtubeStatus,
    staffSelectionStatus: fallbackState.staffSelectionStatus,
    reportedStaffId: fallbackState.reportedStaffId,
    unmuteDecision: fallbackState.unmuteDecision,
    unmuteDecisionBy: fallbackState.unmuteDecisionBy,
    closedById: fallbackState.closedById,
    closedAt: fallbackState.closedAt,
    claimedById: claimedMatch ? claimedMatch[1] : null,
    claimHistory: [],
    assistStaffIds: fallbackState.assistStaffIds,
    assistHistory: fallbackState.assistHistory,
    handoverHistory: fallbackState.handoverHistory,
    pendingHandover: fallbackState.pendingHandover,
    controlMessageId: fallbackState.controlMessageId,
    customChannelName: fallbackState.customChannelName,
  };
}

async function updateTicketTopic(
  channel,
  data,
  patch = {},
  reason = 'Ticket data updated',
) {
  const next = {
    ...data,
    ...patch,
  };

  const storedState = {
    guildId: channel.guildId,
    number: next.number,
    typeKey: next.typeKey,
    creatorId: next.creatorId,
    creatorWasStaff:
      typeof next.creatorWasStaff === 'boolean'
        ? next.creatorWasStaff
        : null,
    claimedById: next.claimedById || null,
    claimHistory: Array.isArray(next.claimHistory)
      ? next.claimHistory
      : [],
    assistStaffIds: Array.isArray(next.assistStaffIds)
      ? [...new Set(next.assistStaffIds.map(String))]
      : [],
    assistHistory: Array.isArray(next.assistHistory)
      ? next.assistHistory
      : [],
    handoverHistory: Array.isArray(next.handoverHistory)
      ? next.handoverHistory
      : [],
    pendingHandover: next.pendingHandover || null,
    controlMessageId: next.controlMessageId || null,
    customChannelName: next.customChannelName || null,
    inGameIdStatus: next.inGameIdStatus,
    youtubeStatus: next.youtubeStatus,
    staffSelectionStatus: next.staffSelectionStatus,
    reportedStaffId: next.reportedStaffId || null,
    unmuteDecision: next.unmuteDecision || null,
    unmuteDecisionBy: next.unmuteDecisionBy || null,
    closedById: next.closedById || null,
    closedAt: next.closedAt || null,
    updatedAt: new Date().toISOString(),
    updateReason: reason,
  };

  await setTicketState(
    channel.id,
    storedState,
  );

  const cachedNext = {
    ...next,
    ...storedState,
  };

  setLiveTicketStateCache(
    channel.id,
    cachedNext,
  );

  return cachedNext;
}


async function getLiveTicketData(channel) {
  if (
    !channel ||
    channel.type !==
      ChannelType.GuildText
  ) {
    return null;
  }

  const channelName =
    String(
      channel.name ||
      '',
    ).toLowerCase();

  const looksLikeLegacyTicketName =
    channelName.startsWith(
      TICKET_NAME_PREFIX,
    ) ||
    channelName.startsWith(
      CLOSED_TICKET_NAME_PREFIX,
    );

  const base =
    getTicketData(
      channel,
    );

  const cached =
    getLiveTicketStateCache(
      channel.id,
    );

  if (cached) {
    return base
      ? {
          ...base,
          ...cached,
        }
      : cached;
  }

  // Avoid a MongoDB read for every ordinary server message. A renamed ticket
  // is recognized by its immutable topic; prefix-only legacy tickets may still
  // fall back to their stored state.
  if (
    !base &&
    !looksLikeLegacyTicketName
  ) {
    return null;
  }

  try {
    const stored =
      await getTicketState(
        channel.id,
      );

    if (
      !base &&
      !stored?.creatorId
    ) {
      return null;
    }

    if (!stored) {
      setLiveTicketStateCache(
        channel.id,
        base,
      );
      return base;
    }

    // Older tickets can have a valid MongoDB record while their historical
    // topic is missing or no longer matches the newest topic format. Treat the
    // stored creator ID as authoritative so their existing Close / Claim
    // buttons keep working after upgrades.
    const numberFromName =
      channelName.match(
        /^(?:ticket-|closed-)(\d+)/i,
      );

    const typeKey =
      stored.typeKey ||
      base?.typeKey ||
      'bug_report';

    const fallbackState =
      initialSubmissionState(
        typeKey,
      );

    const resolvedBase =
      base || {
        number:
          stored.number ??
          (numberFromName
            ? Number(
                numberFromName[1],
              )
            : null),
        typeKey,
        creatorId:
          String(
            stored.creatorId,
          ),
        creatorWasStaff:
          null,
        ...fallbackState,
        claimedById:
          null,
      };

    const live = {
      ...resolvedBase,
      number:
        stored.number ??
        resolvedBase.number,
      typeKey,
      creatorId:
        stored.creatorId ||
        resolvedBase.creatorId,
      creatorWasStaff:
        typeof stored.creatorWasStaff === 'boolean'
          ? stored.creatorWasStaff
          : resolvedBase.creatorWasStaff,
      claimedById:
        stored.claimedById ??
        resolvedBase.claimedById,
      claimHistory:
        Array.isArray(stored.claimHistory) &&
        stored.claimHistory.length
          ? stored.claimHistory
          : resolvedBase.claimHistory,
      assistStaffIds:
        Array.isArray(stored.assistStaffIds)
          ? stored.assistStaffIds.map(String)
          : resolvedBase.assistStaffIds,
      assistHistory:
        Array.isArray(stored.assistHistory)
          ? stored.assistHistory
          : resolvedBase.assistHistory,
      handoverHistory:
        Array.isArray(stored.handoverHistory)
          ? stored.handoverHistory
          : resolvedBase.handoverHistory,
      pendingHandover:
        stored.pendingHandover ||
        resolvedBase.pendingHandover,
      controlMessageId:
        stored.controlMessageId ||
        resolvedBase.controlMessageId,
      customChannelName:
        stored.customChannelName ||
        resolvedBase.customChannelName,
      inGameIdStatus:
        stored.inGameIdStatus ||
        resolvedBase.inGameIdStatus,
      youtubeStatus:
        stored.youtubeStatus ||
        resolvedBase.youtubeStatus,
      staffSelectionStatus:
        stored.staffSelectionStatus ||
        resolvedBase.staffSelectionStatus,
      reportedStaffId:
        stored.reportedStaffId ||
        resolvedBase.reportedStaffId,
      unmuteDecision:
        stored.unmuteDecision ||
        resolvedBase.unmuteDecision,
      unmuteDecisionBy:
        stored.unmuteDecisionBy ||
        resolvedBase.unmuteDecisionBy,
      closedById:
        stored.closedById ||
        resolvedBase.closedById,
      closedAt:
        stored.closedAt ||
        resolvedBase.closedAt,
    };

    setLiveTicketStateCache(
      channel.id,
      live,
    );

    return live;
  } catch (error) {
    console.error(
      '[TICKET STATE READ ERROR]',
      error,
    );
    return base;
  }
}


function mergeOverwrite(
  map,
  id,
  type,
  allowBits = 0n,
  denyBits = 0n,
) {
  const key =
    String(
      id,
    );

  const existing =
    map.get(
      key,
    ) || {
      id:
        key,
      type,
      allow:
        0n,
      deny:
        0n,
    };

  const existingAllow =
    BigInt(
      existing.allow ||
      0n,
    );

  const existingDeny =
    BigInt(
      existing.deny ||
      0n,
    );

  const allow =
    BigInt(
      allowBits ||
      0n,
    );

  const deny =
    BigInt(
      denyBits ||
      0n,
    );

  // Any permission explicitly allowed here must be removed from deny, and any
  // permission explicitly denied here must be removed from allow.
  existing.allow =
    (
      existingAllow |
      allow
    ) &
    ~deny;

  existing.deny =
    (
      existingDeny |
      deny
    ) &
    ~allow;

  existing.id =
    key;

  existing.type =
    type;

  map.set(
    key,
    existing,
  );

  return existing;
}

function buildTicketPermissionOverwrites(
  guild,
  category,
  creatorId,
  botId,
  creatorCanSend,
) {
  const overwriteMap = new Map();

  for (
    const overwrite of
    category.permissionOverwrites.cache.values()
  ) {
    overwriteMap.set(
      String(
        overwrite.id,
      ),
      {
        id:
          String(
            overwrite.id,
          ),
        type:
          overwrite.type,
        allow:
          overwrite.allow.bitfield,
        deny:
          overwrite.deny.bitfield,
      },
    );
  }

  mergeOverwrite(
    overwriteMap,
    guild.roles.everyone.id,
    0,
    0n,
    PermissionFlagsBits.ViewChannel,
  );

  const basePermissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.AttachFiles |
    PermissionFlagsBits.EmbedLinks |
    PermissionFlagsBits.AddReactions |
    PermissionFlagsBits.UseApplicationCommands;

  mergeOverwrite(
    overwriteMap,
    creatorId,
    1,
    creatorCanSend
      ? (
          basePermissions |
          PermissionFlagsBits.SendMessages
        )
      : basePermissions,
    creatorCanSend
      ? 0n
      : PermissionFlagsBits.SendMessages,
  );

  mergeOverwrite(
    overwriteMap,
    botId,
    1,
    basePermissions |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ManageChannels |
      PermissionFlagsBits.ManageMessages |
      PermissionFlagsBits.PinMessages,
    0n,
  );

  // Only nine role overwrites instead of one overwrite per staff member.
  for (
    const roleId of
    STAFF_ROLE_IDS
  ) {
    if (
      !guild.roles.cache.has(
        roleId,
      )
    ) {
      continue;
    }

    mergeOverwrite(
      overwriteMap,
      roleId,
      0,
      basePermissions,
      PermissionFlagsBits.SendMessages,
    );
  }

  return [
    ...overwriteMap.values(),
  ];
}


function shouldCreatorBeUnlocked(data) {
  if (
    TICKET_TYPES[data.typeKey]?.requiresStaffSelection &&
    data.staffSelectionStatus !== 'done'
  ) {
    return false;
  }

  if (!TICKET_TYPES[data.typeKey]?.requiresInGameId) return true;
  if (data.inGameIdStatus !== 'done') return false;
  if (data.typeKey === 'youtuber_submission' && data.youtubeStatus !== 'done') return false;
  return true;
}

async function setCreatorTyping(channel, creatorId, enabled, reason) {
  const id =
    String(
      creatorId,
    );

  const member =
    channel.guild.members.cache.get(
      id,
    ) ||
    (await channel.guild.members
      .fetch(
        id,
      )
      .catch(() => null));

  const desiredOverwrite = {
    ViewChannel: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
    AddReactions: true,
    UseApplicationCommands: true,
    SendMessages:
      Boolean(
        enabled,
      ),
  };

  const currentOverwrite =
    channel.permissionOverwrites.cache.get(
      id,
    );

  const explicitlyAllowsSend =
    Boolean(
      currentOverwrite?.allow?.has(
        PermissionFlagsBits.SendMessages,
      ) &&
      !currentOverwrite?.deny?.has(
        PermissionFlagsBits.SendMessages,
      ),
    );

  const explicitlyDeniesSend =
    Boolean(
      currentOverwrite?.deny?.has(
        PermissionFlagsBits.SendMessages,
      ),
    );

  const effectiveCanSend =
    member
      ? Boolean(
          channel.permissionsFor(
            member,
          )?.has(
            PermissionFlagsBits.SendMessages,
          ),
        )
      : null;

  const alreadyCorrect =
    enabled
      ? (
          explicitlyAllowsSend &&
          effectiveCanSend !==
            false
        )
      : explicitlyDeniesSend;

  if (alreadyCorrect) {
    return false;
  }

  await channel.permissionOverwrites.edit(
    member ||
    id,
    desiredOverwrite,
    reason,
  );

  if (
    !enabled ||
    !member
  ) {
    return true;
  }

  let effective =
    channel.permissionsFor(
      member,
    );

  if (
    effective?.has(
      PermissionFlagsBits.SendMessages,
    )
  ) {
    return true;
  }

  console.warn(
    `[TICKET CREATOR PERMISSION RETRY] ${id} still cannot SendMessages in ${channel.id}; rebuilding their member overwrite.`,
  );

  await channel.permissionOverwrites
    .delete(
      member,
      `${reason} - clearing stale creator deny`,
    )
    .catch((error) => {
      console.error(
        '[TICKET CREATOR OVERWRITE DELETE RETRY ERROR]',
        error,
      );
    });

  await channel.permissionOverwrites.edit(
    member,
    desiredOverwrite,
    `${reason} - rebuilt creator access`,
  );

  effective =
    channel.permissionsFor(
      member,
    );

  if (
    !effective?.has(
      PermissionFlagsBits.SendMessages,
    )
  ) {
    throw new Error(
      `Creator ${id} still lacks SendMessages after rebuilding their ticket overwrite.`,
    );
  }

  return true;
}

async function findExistingTicketForCreator(
  guild,
  creatorId,
) {
  const creatorKey = String(creatorId);

  // MongoDB is the primary lookup. If a ticket state points at a channel that
  // no longer exists (for example after a manual channel deletion), clean that
  // stale state so it does not permanently block the user.
  const storedTickets = await getTicketStatesForCreator(
    guild.id,
    creatorKey,
  ).catch((error) => {
    console.error('[TICKET CREATOR LOOKUP ERROR]', error);
    return [];
  });

  for (const state of storedTickets) {
    const channel =
      guild.channels.cache.get(state.channelId) ||
      (await guild.channels
        .fetch(state.channelId)
        .catch(() => null));

    if (channel) {
      const ticketData = getTicketData(channel);

      if (
        ticketData &&
        String(ticketData.creatorId) === creatorKey
      ) {
        return channel;
      }
    } else {
      await deleteTicketState(state.channelId).catch((error) => {
        console.error(
          '[STALE TICKET STATE CLEANUP ERROR]',
          error,
        );
      });
    }
  }

  // Legacy fallback: tickets created before Mongo state tracking may still be
  // identifiable from their immutable channel topic.
  for (const channel of guild.channels.cache.values()) {
    const ticketData = getTicketData(channel);

    if (
      ticketData &&
      String(ticketData.creatorId) === creatorKey
    ) {
      return channel;
    }
  }

  return null;
}

async function createTicket(interaction, typeKey) {
  if (!TICKET_TYPES[typeKey]) {
    await interaction.reply({
      content: 'That ticket type is no longer available. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The ticket-type menu itself is ephemeral. Acknowledge the selection as an
  // update so the existing menu message is replaced by the ticket-created
  // confirmation instead of creating a separate reply.
  await interaction.deferUpdate();

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      content:
        'Tickets can only be created inside a server.',
      components: [],
    });
    return;
  }

  const selectedType =
    TICKET_TYPES[
      typeKey
    ];

  const creatorMember =
    interaction.member?.roles?.cache
      ? interaction.member
      : guild.members.cache.get(
          interaction.user.id,
        ) ||
        (await guild.members
          .fetch(
            interaction.user.id,
          )
          .catch(() => null));

  const creationDenial = await ticketCreationDenial(guild, creatorMember);
  if (creationDenial) {
    await interaction.editReply({ content: creationDenial, components: [], allowedMentions: { parse: [] } });
    return;
  }

  const creatorWasStaff =
    isTicketStaffMember(
      creatorMember,
    );

  if (
    selectedType
      ?.restrictedToAdministrators
  ) {
    if (
      !isTicketAdministrator(
        creatorMember,
      )
    ) {
      await interaction.editReply({
        content:
          '❌ This ticket type is only available to the bot developer, server owner, and Administrators.',
        components: [],
        allowedMentions: {
          parse: [],
        },
      });

      return;
    }
  }

  const isReportStaff =
    typeKey ===
    'report_staff';
  let configuredCategoryId = REPORT_STAFF_CATEGORY_ID;

  if (!isReportStaff) {
    const config = await getGuildConfig(guild);
    if (!config) {
      await interaction.editReply({
        content: 'The ticket system has not been configured yet. A staff member needs to run `/ticket-panel` first.',
        components: [],
      });
      return;
    }
    configuredCategoryId = config.categoryId;
  }

  try {
    await runTicketCreationQueued(
      guild.id,
      async () => {
        const existingTicket = await findExistingTicketForCreator(
      guild,
      interaction.user.id,
    );

    if (existingTicket) {
      await interaction.editReply({
        content:
          `❌ You already have a ticket open: <#${existingTicket.id}>\n` +
          'You can create another ticket after your existing ticket has been deleted.',
        components: [],
        allowedMentions: {
          parse: [],
        },
      });
      return;
    }

    const category = await guild.channels
      .fetch(configuredCategoryId)
      .catch(() => null);

    if (!category || category.type !== ChannelType.GuildCategory) {
      await interaction.editReply({
        content: isReportStaff
          ? `The private **Report Staff** category (${REPORT_STAFF_CATEGORY_ID}) could not be found in this server.`
          : 'The configured ticket category no longer exists. Staff need to run `/ticket-panel reconfigure:true`.',
        components: [],
      });
      return;
    }

    const botMember = guild.members.me || (await guild.members.fetchMe());
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply({
        content: 'I need the **Manage Channels** permission to create tickets.',
        components: [],
      });
      return;
    }

    let reportStaffMembers = [];
    if (isReportStaff || typeKey === 'muted_without_reason') {
      reportStaffMembers = await getReportableStaffMembers(
        guild,
        interaction.user.id,
      );

      // Report Staff requires a staff selection, so it cannot continue with an
      // empty list. The mute appeal selector is optional, so that ticket can
      // still be created even if no eligible staff are currently returned.
      if (isReportStaff && !reportStaffMembers.length) {
        await interaction.editReply({
          content:
            'I could not find any staff members with **View Audit Log** permission. ' +
            'Make sure **Server Members Intent** is enabled for the bot and that your staff roles have **View Audit Log**.',
          components: [],
        });
        return;
      }
    }

    let ticketNumber;
    try {
      ticketNumber = await getNextTicketNumber(guild.id);
      console.log(
        `[TICKET COUNTER] Allocated ticket #${ticketNumber} for guild ${guild.id}.`,
      );
    } catch (error) {
      console.error('[TICKET COUNTER ERROR]', error);
      await interaction.editReply({
        content: 'I could not allocate a ticket number from the database. Please try again.',
        components: [],
      });
      return;
    }
    const state = initialSubmissionState(typeKey);
    const creatorCanSend = shouldCreatorBeUnlocked({ typeKey, ...state });

    let permissionOverwrites;

    try {
      permissionOverwrites =
        isReportStaff
          ? buildReportStaffPermissionOverwrites(
              guild,
              interaction.user.id,
              botMember.id,
            )
          : buildTicketPermissionOverwrites(
              guild,
              category,
              interaction.user.id,
              botMember.id,
              creatorCanSend,
            );
    } catch (error) {
      console.error(
        '[TICKET PERMISSION BUILD ERROR]',
        error,
      );

      await interaction.editReply({
        content:
          '❌ I could not prepare the ticket channel permissions. Please try again.',
        components: [],
        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    let channel;
    try {
      channel = await guild.channels.create({
        name: `${TICKET_NAME_PREFIX}${ticketNumber}_${TICKET_TYPES[typeKey].slug}`,
        type: ChannelType.GuildText,
        parent: category.id,
        ...(isReportStaff
          ? { position: getBottomPositionForCategory(category) }
          : {}),
        topic: makeTicketTopic(ticketNumber, typeKey, interaction.user.id, null, state),
        permissionOverwrites,
        reason: `Ticket #${ticketNumber} (${TICKET_TYPES[typeKey].label}) created by ${interaction.user.tag}`,
      });
    } catch (error) {
      console.error('[TICKET CREATE ERROR]', error);
      await interaction.editReply({
        content: 'I could not create your ticket. Check my channel and permission settings.',
        components: [],
      });
      return;
    }

    // Verify the creator's member overwrite after Discord creates the
    // channel. If inherited category denies survived unexpectedly, rebuild the
    // overwrite before the user begins using the ticket.
    await setCreatorTyping(
      channel,
      interaction.user.id,
      creatorCanSend,
      `Verified ticket creator access for ticket #${ticketNumber}`,
    ).catch((error) => {
      console.error(
        `[TICKET CREATE CREATOR PERMISSION ERROR] ${channel.id}/${interaction.user.id}`,
        error,
      );
    });

    // This must be the first message in normal tickets so the staff alert is
    // delivered before the ticket welcome and controls. Report Staff remains
    // private and never pings the general ticket alert role.
    if (!isReportStaff) {
      await channel.send({
        content:
          `<@&${TICKET_ALERT_ROLE_ID}>`,
        allowedMentions: {
          roles: [
            TICKET_ALERT_ROLE_ID,
          ],
        },
      }).catch((error) => {
        console.error(
          '[TICKET ALERT ROLE PING ERROR]',
          error,
        );
      });
    }

    try {
      await setTicketState(channel.id, {
        guildId: guild.id,
        number: ticketNumber,
        typeKey,
        creatorId: interaction.user.id,
        creatorWasStaff,
        claimedById: null,
        claimHistory: [],
        assistStaffIds: [],
        assistHistory: [],
        handoverHistory: [],
        pendingHandover: null,
        controlMessageId: null,
        closedById: null,
        closedAt: null,
        inGameIdStatus: state.inGameIdStatus,
        youtubeStatus: state.youtubeStatus,
        staffSelectionStatus: state.staffSelectionStatus,
        reportedStaffId: state.reportedStaffId,
        unmuteDecision: state.unmuteDecision,
        unmuteDecisionBy: state.unmuteDecisionBy,
        updatedAt: new Date().toISOString(),
        updateReason: 'Ticket created',
      });
    } catch (error) {
      console.error('[TICKET STATE CREATE ERROR]', error);
    }

    try {
      const controlMessage =
        await channel.send(
          buildTicketWelcome(
            ticketNumber,
            interaction.user,
            typeKey,
            {
              reportStaffMembers,
              claimedById: null,
            },
          ),
        );

      await setTicketState(
        channel.id,
        {
          guildId:
            guild.id,
          number:
            ticketNumber,
          typeKey,
          creatorId:
            interaction.user.id,
          creatorWasStaff,
          claimedById:
            null,
          claimHistory: [],
          assistStaffIds: [],
          assistHistory: [],
          handoverHistory: [],
          pendingHandover:
            null,
          controlMessageId:
            controlMessage.id,
          closedById:
            null,
          closedAt:
            null,
          inGameIdStatus:
            state.inGameIdStatus,
          youtubeStatus:
            state.youtubeStatus,
          staffSelectionStatus:
            state.staffSelectionStatus,
          reportedStaffId:
            state.reportedStaffId,
          unmuteDecision:
            state.unmuteDecision,
          unmuteDecisionBy:
            state.unmuteDecisionBy,
          updatedAt:
            new Date().toISOString(),
          updateReason:
            'Ticket control message created',
        },
      ).catch((error) => {
        console.error(
          '[TICKET CONTROL STATE SAVE ERROR]',
          error,
        );
      });

      await pinTicketControlMessage(
        controlMessage,
      );
    } catch (error) {
      console.error('[TICKET WELCOME ERROR]', error);
    }

    if (isReportStaff) {
      await channel.send({
        embeds: [
          buildReportStaffGuidelinesEmbed(),
        ],
        allowedMentions: {
          parse: [],
        },
      }).catch((error) => {
        console.error(
          '[REPORT STAFF GUIDELINES ERROR]',
          error,
        );
      });
    }

        await interaction.editReply({
          content:
            `✅ Your **${TICKET_TYPES[typeKey].label}** ticket has been created.\n` +
            `🎫 **Ticket:** <#${channel.id}>`,
          components: [],
          allowedMentions: {
            parse: [],
          },
        });
      },
    );
  } catch (error) {
    console.error(
      '[TICKET CREATE UNEXPECTED ERROR]',
      error,
    );

    const errorId =
      Date.now()
        .toString(36)
        .toUpperCase();

    await interaction
      .editReply({
        content:
          `❌ I could not create that ticket due to an unexpected error. ` +
          `Please try again. Error reference: \`${errorId}\``,
        components: [],
        allowedMentions: {
          parse: [],
        },
      })
      .catch((responseError) => {
        console.error(
          '[TICKET CREATE ERROR RESPONSE FAILED]',
          responseError,
        );
      });
  }
}

function messageHasButton(message, customId) {
  return Boolean(
    message?.components?.some((row) =>
      row.components?.some((component) => component.customId === customId),
    ),
  );
}

function isTicketClosedForCreator(channel, creatorId) {
  const overwrite = channel.permissionOverwrites.cache.get(creatorId);
  return Boolean(
    overwrite?.deny?.has(PermissionFlagsBits.ViewChannel),
  );
}

// One rename worker per ticket channel.
//
// Discord rate-limits channel edits. If a ticket is opened/closed several times
// quickly, sending every rename request independently can leave old queued
// renames running after the ticket state has already changed again.
//
// This worker collapses pending requests down to the NEWEST desired name, so
// after Discord's rate limit clears the channel always catches up to the latest
// open/closed state instead of replaying every stale rename.
const ticketRenameStates = new Map();

function requestTicketChannelRename(channel, name, reason) {
  if (!channel || !name) return;

  let state = ticketRenameStates.get(channel.id);

  if (!state) {
    state = {
      channelId: channel.id,
      client: channel.client,
      desiredName: name,
      reason,
      running: false,
    };
    ticketRenameStates.set(channel.id, state);
  } else {
    state.desiredName = name;
    state.reason = reason;
  }

  if (!state.running) {
    processTicketChannelRename(state).catch((error) => {
      console.error('[TICKET RENAME WORKER ERROR]', error);
    });
  }
}

async function processTicketChannelRename(state) {
  state.running = true;

  try {
    while (ticketRenameStates.get(state.channelId) === state) {
      let channel;
      try {
        channel =
          state.client.channels.cache.get(state.channelId) ||
          (await state.client.channels.fetch(state.channelId));
      } catch (error) {
        console.error('[TICKET RENAME FETCH ERROR]', error);
        ticketRenameStates.delete(state.channelId);
        return;
      }

      const targetName = state.desiredName;
      const targetReason = state.reason;

      if (channel.name !== targetName) {
        try {
          console.log(
            `[TICKET RENAME] ${channel.name} -> ${targetName} (${state.channelId})`,
          );

          // Await this one request so discord.js can respect Discord's route
          // rate-limit instead of us stacking lots of stale channel edits.
          await channel.setName(targetName, targetReason);

          console.log(
            `[TICKET RENAME] Channel ${state.channelId} is now ${targetName}.`,
          );
        } catch (error) {
          console.error('[TICKET RENAME ERROR]', error);

          // Do not make ticket close/open wait on a channel-name edit. Discord
          // has route-specific rate limits and discord.js handles retry timing.
          // The permission state and staff controls are the source of truth.
          ticketRenameStates.delete(state.channelId);
          return;
        }
      }

      // If the target did not change while the request was in progress, we're
      // caught up and can stop this worker. If it changed, loop once more using
      // only the newest requested state.
      if (state.desiredName === targetName) {
        ticketRenameStates.delete(state.channelId);
        return;
      }
    }
  } finally {
    state.running = false;

    // A new target may have arrived at the exact moment the worker stopped.
    if (
      ticketRenameStates.get(state.channelId) === state &&
      !state.running
    ) {
      processTicketChannelRename(state).catch((error) => {
        console.error('[TICKET RENAME WORKER ERROR]', error);
      });
    }
  }
}

async function closeTicket(interaction) {
  const baseData = getTicketData(interaction.channel);
  if (!baseData) {
    const liveData =
      await getLiveTicketData(
        interaction.channel,
      ).catch(
        () =>
          null,
      );

    if (
      !liveData
    ) {
      console.warn(
        `[TICKET CLOSE STALE CONTROL] Ignored Close outside a ticket in ` +
          `${interaction.channelId || interaction.channel?.id || 'unknown'}.`,
      );

      await interaction
        .deferUpdate()
        .catch(
          () =>
            {},
        );

      return;
    }
  }

  const data =
    (await getLiveTicketData(interaction.channel).catch(() => null)) ||
    baseData;

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member) {
    await interaction.reply({
      content: 'I could not verify your server permissions.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isReportStaff = data.typeKey === 'report_staff';
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
  const isReportedStaff =
    isReportStaff &&
    data.reportedStaffId &&
    data.reportedStaffId === interaction.user.id;

  if (isReportStaff) {
    // If the person being reported is an Administrator, they are NEVER allowed
    // to close their own report. Their attempt is automatically archived to the
    // protected transcript channel.
    if (isReportedStaff && isAdmin) {
      await interaction.reply({
        content:
          '⛔ You cannot close a **Report Staff** ticket that is reporting you. ' +
          'A transcript of the current ticket is being archived automatically.',
        flags: MessageFlags.Ephemeral,
      });

      try {
        await sendReportStaffSecurityTranscript(
          interaction.channel,
          data,
          interaction.user,
          'Reported administrator attempted to close their own report',
        );

        await interaction.editReply(
          `⛔ Close blocked. The transcript was sent to <#${REPORT_STAFF_SECURITY_LOG_CHANNEL_ID}>.`,
        );
      } catch (error) {
        console.error('[REPORT STAFF BLOCKED CLOSE TRANSCRIPT ERROR]', error);
        await interaction.editReply(
          '⛔ Close blocked. I could not archive the transcript, so an administrator should check the security log channel permissions.',
        ).catch(() => {});
      }

      return;
    }

    // Report Staff tickets are deliberately stricter than normal tickets:
    // ONLY members with Administrator may close them.
    if (!isAdmin) {
      await interaction.reply({
        content:
          'Only a server member with **Administrator** permission can close a **Report Staff** ticket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    const isCreator =
      data.creatorId ===
      interaction.user.id;

    const isStaff =
      isStaffForTicket(
        interaction,
        member,
      );

    if (
      !isCreator &&
      !isStaff
    ) {
      await interaction.reply({
        content:
          'Only the ticket creator or a member of the **staff team** can close this ticket.',
        flags:
          MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // Acknowledge instantly so Discord never sits on "thinking..." while the bot
  // performs permission/message work.
  await interaction.reply({
    content: '🔒 Closing ticket…',
    flags: MessageFlags.Ephemeral,
  });

  if (
    data.closedAt ||
    String(
      interaction.channel.name ||
      '',
    )
      .toLowerCase()
      .startsWith(
        CLOSED_TICKET_NAME_PREFIX,
      )
  ) {
    // A previous Close may have saved the closed state but been interrupted
    // before its Transcript / Open / Delete controls were posted. Repair that
    // partial state when staff press the still-visible Close button again.
    const recentMessages =
      await interaction.channel.messages
        .fetch({
          limit:
            50,
        })
        .catch(() => null);

    const existingClosedControls =
      recentMessages?.find(
        (message) =>
          message.author?.id ===
            interaction.client.user.id &&
          messageHasButton(
            message,
            'ticket_delete',
          ) &&
          messageHasButton(
            message,
            'ticket_reopen',
          ),
      );

    if (!existingClosedControls) {
      await interaction.channel.send(
        buildClosedTicketMessage(
          data.closedById ||
          interaction.user.id,
        ),
      );

      interaction.message
        .edit({
          components: [],
        })
        .catch((error) => {
          console.error(
            '[TICKET CLOSE RECOVERY CONTROL DISABLE ERROR]',
            error,
          );
        });

      await interaction.editReply(
        '✅ Closed ticket controls restored. You can now use **Delete**.',
      );
      return;
    }

    await interaction.editReply(
      'This ticket is already closed. Use the **Delete** button in the closed ticket controls.',
    );
    return;
  }

  const type = TICKET_TYPES[data.typeKey] || TICKET_TYPES.bug_report;
  const ticketNumber = data.number ?? 0;
  const closedName =
    buildTicketChannelName(
      CLOSED_TICKET_NAME_PREFIX,
      ticketNumber,
      getTicketChannelLabel(
        interaction.channel,
        data,
      ) ||
        type.slug,
    );

  try {
    const creatorMember =
      interaction.guild.members.cache.get(
        String(
          data.creatorId,
        ),
      ) ||
      (await interaction.guild.members
        .fetch(
          String(
            data.creatorId,
          ),
        )
        .catch(() => null));

    const creatorIsStaff =
      !isReportStaff &&
      isTicketStaffMember(
        creatorMember,
      );

    if (creatorIsStaff) {
      // Keep the staff creator's overwrite repaired in the background. This
      // request must not hold Close on "Closing ticket..." if Discord delays
      // the permission route.
      interaction.channel.permissionOverwrites
        .edit(
          data.creatorId,
          {
            ViewChannel: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
            SendMessages: true,
          },
          `Staff ticket creator retained access after close by ${interaction.user.tag}`,
        )
        .catch((error) => {
          console.error(
            '[TICKET CLOSE STAFF CREATOR ACCESS ERROR]',
            error,
          );
        });

      console.log(
        `[TICKET CLOSE] Staff creator ${data.creatorId} kept access to closed ticket #${ticketNumber}.`,
      );
    } else {
      // Normal customers are hidden from the ticket after it is closed.
      await interaction.channel.permissionOverwrites.edit(
        data.creatorId,
        {
          ViewChannel: false,
          SendMessages: false,
        },
        `Ticket closed by ${interaction.user.tag}`,
      );

      console.log(
        `[TICKET CLOSE] Creator ${data.creatorId} hidden from ticket #${ticketNumber}.`,
      );
    }

    const closedAt = new Date();

    await updateTicketTopic(
      interaction.channel,
      data,
      {
        closedById: interaction.user.id,
        closedAt: closedAt.toISOString(),
      },
      `Ticket closed by ${interaction.user.tag}`,
    );

    // Send the controls BEFORE requesting the rename. This keeps close/reopen
    // instant even when Discord queues repeated channel-name changes.
    await interaction.channel.send(buildClosedTicketMessage(interaction.user.id));

    // The closed controls now exist, so clear the ephemeral status immediately.
    // Old-button cleanup is best effort and must never delay access to Delete.
    await interaction.editReply('✅ Ticket closed.');

    interaction.message
      .edit({
        components: [],
      })
      .catch((error) => {
        console.error(
          '[TICKET CLOSE STALE CONTROL DISABLE ERROR]',
          error,
        );
      });

    requestTicketChannelRename(
      interaction.channel,
      closedName,
      `Ticket closed by ${interaction.user.tag}`,
    );
  } catch (error) {
    console.error('[TICKET CLOSE ERROR]', error);
    await interaction.editReply(
      'I could not fully close the ticket. Check my **Manage Channels**, **Manage Messages**, and channel permissions.',
    ).catch(() => {});
  }
}

function isStaffForTicket(
  interaction,
  member,
) {
  if (
    !interaction?.guild ||
    !member
  ) {
    return false;
  }

  // Ticket staff access follows the configured Snay.io staff hierarchy.
  // Staff do NOT need Discord's raw Manage Messages permission just to use
  // bot-managed Close / Delete / Reopen / Transcript controls.
  return isTicketStaffMember(
    member,
  );
}

async function getTicketRenameContext(
  interaction,
) {
  const data =
    await getLiveTicketData(
      interaction.channel,
    );

  if (!data) {
    return {
      error:
        'This Rename control is no longer attached to a ticket.',
    };
  }

  if (
    data.typeKey ===
      'report_staff'
  ) {
    return {
      error:
        'Report Staff tickets cannot be renamed.',
    };
  }

  if (
    data.closedAt ||
    String(
      interaction.channel?.name ||
      '',
    )
      .toLowerCase()
      .startsWith(
        CLOSED_TICKET_NAME_PREFIX,
      )
  ) {
    return {
      error:
        'Reopen this ticket before renaming it.',
    };
  }

  const member =
    interaction.member?.roles?.cache
      ? interaction.member
      : await interaction.guild.members
          .fetch(
            interaction.user.id,
          )
          .catch(() => null);

  if (
    !isStaffForTicket(
      interaction,
      member,
    )
  ) {
    return {
      error:
        'Only a member of the staff team can rename tickets.',
    };
  }

  return {
    data,
    member,
  };
}

async function openTicketRenameModal(
  interaction,
) {
  const context =
    await getTicketRenameContext(
      interaction,
    );

  if (context.error) {
    await interaction.reply({
      content:
        context.error,
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const input =
    new TextInputBuilder()
      .setCustomId(
        'ticket_rename_value',
      )
      .setLabel(
        'New ticket name',
      )
      .setPlaceholder(
        'Example: payment-refund',
      )
      .setStyle(
        TextInputStyle.Short,
      )
      .setRequired(
        true,
      )
      .setMinLength(
        1,
      )
      .setMaxLength(
        100,
      )
      .setValue(
        getTicketChannelLabel(
          interaction.channel,
          context.data,
        ),
      );

  const modal =
    new ModalBuilder()
      .setCustomId(
        `ticket_rename_modal:${interaction.channel.id}`,
      )
      .setTitle(
        'Rename Ticket',
      )
      .addComponents(
        new ActionRowBuilder()
          .addComponents(
            input,
          ),
      );

  await interaction.showModal(
    modal,
  );
}

async function handleTicketRenameModal(
  interaction,
) {
  const expectedChannelId =
    interaction.customId.split(
      ':',
    )[1];

  if (
    expectedChannelId !==
      interaction.channelId
  ) {
    await interaction.reply({
      content:
        'This Rename form belongs to a different ticket.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const context =
    await getTicketRenameContext(
      interaction,
    );

  if (context.error) {
    await interaction.reply({
      content:
        context.error,
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const label =
    normalizeTicketChannelLabel(
      interaction.fields.getTextInputValue(
        'ticket_rename_value',
      ),
    );

  if (!label) {
    await interaction.reply({
      content:
        'Enter a ticket name containing at least one letter or number.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  // The staff input becomes the complete visible channel name. Ticket
  // identity remains safely stored in the immutable topic and MongoDB.
  const newName =
    label;

  if (
    interaction.channel.name ===
      newName
  ) {
    await interaction.reply({
      content:
        `The ticket is already named **${newName}**.`,
      flags:
        MessageFlags.Ephemeral,
      allowedMentions: {
        parse: [],
      },
    });
    return;
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    await updateTicketTopic(
      interaction.channel,
      context.data,
      {
        customChannelName:
          newName,
      },
      `Ticket renamed by ${interaction.user.tag}`,
    );

    // Channel renames share Discord's heavily rate-limited Modify Channel
    // route. Queue the request in the existing per-ticket worker so this modal
    // can respond immediately instead of remaining on "thinking".
    requestTicketChannelRename(
      interaction.channel,
      newName,
      `Ticket renamed by ${interaction.user.tag}`,
    );

    await interaction.editReply({
      content:
        `✅ Ticket rename queued as **${newName}**. Discord will apply it shortly.`,
      allowedMentions: {
        parse: [],
      },
    });

    console.log(
      `[TICKET RENAME QUEUED] ${interaction.channelId} -> ${newName} by ${interaction.user.id}.`,
    );
  } catch (error) {
    console.error(
      '[TICKET RENAME STATE ERROR]',
      error,
    );

    await interaction.editReply(
      'I could not save this ticket rename. Please try again.',
    ).catch(() => {});
  }
}


async function reopenTicket(interaction) {
  const baseData = getTicketData(interaction.channel);
  if (!baseData || !messageHasButton(interaction.message, 'ticket_reopen')) {
    await interaction.reply({
      content: 'These closed-ticket controls are no longer active.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const liveForPermissionCheck =
    (await getLiveTicketData(interaction.channel).catch(() => null)) ||
    baseData;

  if (
    liveForPermissionCheck.typeKey === 'report_staff' &&
    liveForPermissionCheck.reportedStaffId === interaction.user.id
  ) {
    await interaction.reply({
      content: 'You cannot reopen a **Report Staff** ticket that is reporting you.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    liveForPermissionCheck.typeKey === 'report_staff' &&
    !member?.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content: 'Only a server **Administrator** can reopen a Report Staff ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    liveForPermissionCheck.typeKey !== 'report_staff' &&
    !isStaffForTicket(interaction, member)
  ) {
    await interaction.reply({
      content: 'Only a member of the **staff team** can reopen normal tickets.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: '🔓 Reopening ticket…',
    flags: MessageFlags.Ephemeral,
  });

  const data = (await getLiveTicketData(interaction.channel)) || baseData;
  const type = TICKET_TYPES[data.typeKey] || TICKET_TYPES.bug_report;
  const ticketNumber = data.number ?? 0;
  const openName =
    data.customChannelName ||
    buildTicketChannelName(
      TICKET_NAME_PREFIX,
      ticketNumber,
      type.slug,
    );
  const creatorCanSend = shouldCreatorBeUnlocked(data);

  console.log(
    `[TICKET REOPEN] Starting ticket #${ticketNumber} in ${interaction.channel.id} ` +
      `by ${interaction.user.tag} (${interaction.user.id}).`,
  );

  // Step 1: restore the ticket creator's channel permissions.
  try {
    console.log('[TICKET REOPEN] Restoring creator permissions...');

    await setCreatorTyping(
      interaction.channel,
      data.creatorId,
      creatorCanSend,
      `Ticket reopened by ${interaction.user.tag}`,
    );

    console.log(
      `[TICKET REOPEN] Creator permissions restored. ` +
        `ViewChannel=true SendMessages=${creatorCanSend}.`,
    );
  } catch (error) {
    console.error('[TICKET REOPEN PERMISSIONS ERROR]', error);
    await interaction.editReply(
      'I could not restore the ticket creator\'s access. The staff controls have been left in place so you can try again.',
    ).catch(() => {});
    return;
  }

  if (
    data.typeKey !==
    'report_staff'
  ) {
    await applyTicketStaffTypingState(
      interaction.channel,
      data,
      `Ticket reopened by ${interaction.user.tag}`,
    ).catch((error) => {
      console.error(
        '[TICKET REOPEN STAFF PERMISSION ERROR]',
        error,
      );
    });

    await refreshTicketControlMessage(
      interaction.channel,
      data,
    ).catch((error) => {
      console.error(
        '[TICKET REOPEN CONTROL REFRESH ERROR]',
        error,
      );
    });
  }

  // Step 2: notify the creator. Do this before removing the staff controls so a
  // failed send never leaves the ticket with no way to retry reopening.
  try {
    console.log('[TICKET REOPEN] Sending reopen notification...');

    const reopenedEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription(`🔓 **Ticket reopened by <@${interaction.user.id}>**`);

    await interaction.channel.send({
      content: creatorCanSend
        ? `<@${data.creatorId}> your ticket has been reopened.`
        : `<@${data.creatorId}> your ticket has been reopened. Complete the required submission steps above before you can type.`,
      embeds: [reopenedEmbed],
      // The ticket creator can also be the staff member reopening the ticket.
      // Discord rejects duplicate IDs in allowed_mentions.users, so de-duplicate them.
      allowedMentions: {
        users: [...new Set([data.creatorId, interaction.user.id])],
      },
    });

    console.log('[TICKET REOPEN] Reopen notification sent.');
  } catch (error) {
    console.error('[TICKET REOPEN NOTIFICATION ERROR]', error);

    // Best effort: put the creator back into the closed state because the reopen
    // did not complete. This prevents a half-open ticket.
    await interaction.channel.permissionOverwrites.edit(
      data.creatorId,
      {
        ViewChannel: false,
        SendMessages: false,
      },
      'Reopen rolled back after notification failure',
    ).catch((rollbackError) => {
      console.error('[TICKET REOPEN ROLLBACK ERROR]', rollbackError);
    });

    await interaction.editReply(
      'I could not send the reopen notification, so the ticket was left closed and the staff controls are still available.',
    ).catch(() => {});
    return;
  }

  // Step 3: request the channel rename. Discord can rate-limit channel renames,
  // so this is deliberately non-blocking and is not allowed to make reopening fail.
  console.log(`[TICKET REOPEN] Requesting channel rename to ${openName}...`);
  requestTicketChannelRename(
    interaction.channel,
    openName,
    `Ticket reopened by ${interaction.user.tag}`,
  );

  // Step 4: only now remove the old closed-ticket staff controls.
  try {
    console.log('[TICKET REOPEN] Removing old staff control message...');
    await interaction.message.delete();
    console.log('[TICKET REOPEN] Old staff control message removed.');
  } catch (error) {
    // The ticket is already successfully reopened at this point. A stale control
    // message is safer than treating the reopen as failed.
    console.error('[TICKET REOPEN CONTROL CLEANUP ERROR]', error);

    await interaction.message.edit({
      components: [],
    }).catch(() => {});
  }

  await updateTicketTopic(
    interaction.channel,
    data,
    {
      closedById: null,
      closedAt: null,
    },
    `Ticket reopened by ${interaction.user.tag}`,
  ).catch((error) => {
    console.error('[TICKET REOPEN STATE CLEAR ERROR]', error);
  });

  console.log(`[TICKET REOPEN] Ticket #${ticketNumber} reopened successfully.`);

  await interaction.editReply('✅ Ticket reopened.').catch(() => {});
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function collectTranscriptMentionIds(messages) {
  const users = new Set();
  const roles = new Set();
  const channels = new Set();

  const scan = (value) => {
    const content = String(value || '');

    for (const match of content.matchAll(/<@!?(\d{16,22})>/g)) users.add(match[1]);
    for (const match of content.matchAll(/<@&(\d{16,22})>/g)) roles.add(match[1]);
    for (const match of content.matchAll(/<#(\d{16,22})>/g)) channels.add(match[1]);
  };

  for (const message of messages) {
    if (message.author?.id) users.add(String(message.author.id));
    scan(message.content);

    for (const embed of message.embeds || []) {
      scan(embed.title);
      scan(embed.description);
      scan(embed.footer?.text);
      scan(embed.author?.name);

      for (const field of embed.fields || []) {
        scan(field.name);
        scan(field.value);
      }
    }
  }

  return { users, roles, channels };
}

function transcriptNumberToHex(value, fallback = '#f2f3f5') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;

  return `#${Math.min(number, 0xffffff).toString(16).padStart(6, '0')}`;
}

function normalizeTranscriptHexColor(value, fallback = '#f2f3f5') {
  const candidate = String(value || '').trim();

  if (/^#[0-9a-f]{6}$/i.test(candidate)) {
    return candidate.toLowerCase() === '#000000' ? fallback : candidate;
  }

  return fallback;
}

function transcriptHexToRgba(hex, alpha = 0.18) {
  const value = normalizeTranscriptHexColor(hex, '#5865f2').replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);

  return `rgba(${r},${g},${b},${alpha})`;
}

function getTranscriptRoleColors(role) {
  const colors = role?.colors || null;

  return {
    primary: colors?.primaryColor
      ? transcriptNumberToHex(colors.primaryColor)
      : normalizeTranscriptHexColor(role?.hexColor, '#f2f3f5'),
    secondary: colors?.secondaryColor
      ? transcriptNumberToHex(colors.secondaryColor)
      : null,
    tertiary: colors?.tertiaryColor
      ? transcriptNumberToHex(colors.tertiaryColor)
      : null,
  };
}

function getTranscriptRoleIcon(role) {
  if (!role) return { iconUrl: null, unicodeEmoji: null };

  let iconUrl = null;

  try {
    iconUrl = role.iconURL?.({ extension: 'webp', size: 64 }) || null;
  } catch {
    iconUrl = null;
  }

  return {
    iconUrl,
    unicodeEmoji: role.unicodeEmoji || null,
  };
}

function getTranscriptMemberStyle(member) {
  if (!member) {
    return {
      colors: { primary: '#f2f3f5', secondary: null, tertiary: null },
      roleIconUrl: null,
      roleUnicodeEmoji: null,
    };
  }

  // These are the exact roles discord.js exposes for member colour and icon.
  const colorRole = member.roles?.color || null;
  const iconRole = member.roles?.icon || null;

  const colors = colorRole
    ? getTranscriptRoleColors(colorRole)
    : {
        primary: normalizeTranscriptHexColor(member.displayHexColor, '#f2f3f5'),
        secondary: null,
        tertiary: null,
      };

  const icon = getTranscriptRoleIcon(iconRole);

  return {
    colors,
    roleIconUrl: icon.iconUrl,
    roleUnicodeEmoji: icon.unicodeEmoji,
  };
}

function getTranscriptNameStyle(style) {
  const colors = style?.colors || {};
  const primary = normalizeTranscriptHexColor(colors.primary, '#f2f3f5');
  const list = [primary, colors.secondary, colors.tertiary].filter(Boolean);

  if (list.length >= 2) {
    return (
      `background-image:linear-gradient(90deg,${list.join(',')});` +
      'background-clip:text;-webkit-background-clip:text;' +
      'color:transparent;-webkit-text-fill-color:transparent;'
    );
  }

  return `color:${primary};`;
}

function getTranscriptMentionStyle(style) {
  const primary = normalizeTranscriptHexColor(
    style?.colors?.primary,
    '#c9cdfb',
  );

  return `color:${primary};background:${transcriptHexToRgba(primary, 0.18)};`;
}

function transcriptMimeFromUrl(url) {
  const pathname = String(url || '').split('?')[0].toLowerCase();

  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.avif')) return 'image/avif';

  return 'application/octet-stream';
}

async function downloadTranscriptAsset(url, maxBytes = 20 * 1024 * 1024) {
  const source = String(url || '').trim();
  if (!source) return null;

  try {
    const response = await fetch(source, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Snay-Ticket-Transcript/1.0' },
    });

    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get('content-length'));

    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer.length || buffer.length > maxBytes) return null;

    const contentType =
      String(
        response.headers.get('content-type') ||
          transcriptMimeFromUrl(source),
      ).split(';')[0].trim() || 'application/octet-stream';

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.error(
      '[TRANSCRIPT ASSET DOWNLOAD ERROR]',
      source,
      error?.message || error,
    );
    return null;
  }
}

async function mapTranscriptWithConcurrency(items, concurrency, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), list.length || 1) },
      () => run(),
    ),
  );

  return results;
}

function transcriptAssetSource(context, url) {
  const source = String(url || '');
  return context?.assetDataUrls?.get(source) || source;
}

async function buildTranscriptRenderContext(channel, messages) {
  await channel.guild.roles.fetch().catch((error) => {
    console.error('[TRANSCRIPT ROLE FETCH ERROR]', error);
  });

  const messagesById = new Map(
    messages.map((message) => [String(message.id), message]),
  );

  const replyMessages = new Map();

  await mapTranscriptWithConcurrency(
    messages.filter((message) => message.reference?.messageId),
    5,
    async (message) => {
      const referenceId = String(message.reference.messageId);

      let referenced = messagesById.get(referenceId) || null;

      if (!referenced && typeof message.fetchReference === 'function') {
        referenced = await message.fetchReference().catch(() => null);
      }

      if (referenced) {
        replyMessages.set(String(message.id), referenced);
      }
    },
  );

  const relevantMessages = [...messages, ...replyMessages.values()];
  const ids = collectTranscriptMentionIds(relevantMessages);

  const userNames = new Map();
  const userStyles = new Map();
  const roleNames = new Map();
  const roleStyles = new Map();
  const channelNames = new Map();

  await Promise.all(
    [...ids.users].map(async (userId) => {
      const member =
        channel.guild.members.cache.get(userId) ||
        (await channel.guild.members.fetch(userId).catch(() => null));

      const user =
        member?.user ||
        channel.client.users.cache.get(userId) ||
        (await channel.client.users.fetch(userId).catch(() => null));

      userNames.set(
        userId,
        member?.displayName ||
          user?.globalName ||
          user?.username ||
          `User ${userId}`,
      );

      userStyles.set(userId, getTranscriptMemberStyle(member));
    }),
  );

  await Promise.all(
    [...ids.roles].map(async (roleId) => {
      const role =
        channel.guild.roles.cache.get(roleId) ||
        (await channel.guild.roles.fetch(roleId).catch(() => null));

      roleNames.set(roleId, role?.name || `Role ${roleId}`);

      const icon = getTranscriptRoleIcon(role);

      roleStyles.set(roleId, {
        colors: getTranscriptRoleColors(role),
        roleIconUrl: icon.iconUrl,
        roleUnicodeEmoji: icon.unicodeEmoji,
      });
    }),
  );

  await Promise.all(
    [...ids.channels].map(async (channelId) => {
      const mentionedChannel =
        channel.guild.channels.cache.get(channelId) ||
        (await channel.guild.channels.fetch(channelId).catch(() => null));

      channelNames.set(
        channelId,
        mentionedChannel?.name || `channel-${channelId}`,
      );
    }),
  );

  const assetUrls = new Set();

  const addMessageAssets = (message) => {
    const avatar = message.author?.displayAvatarURL?.({
      extension: 'png',
      size: 128,
    });

    if (avatar) assetUrls.add(avatar);

    for (const attachment of message.attachments?.values?.() || []) {
      if (isTranscriptImageAttachment(attachment)) {
        if (attachment.url) assetUrls.add(attachment.url);
        if (attachment.proxyURL) assetUrls.add(attachment.proxyURL);
      }
    }

    for (const embed of message.embeds || []) {
      if (embed.image?.url) assetUrls.add(embed.image.url);
      if (embed.thumbnail?.url) assetUrls.add(embed.thumbnail.url);
    }

    for (const sticker of message.stickers?.values?.() || []) {
      if (sticker.url) assetUrls.add(sticker.url);
    }

    const scanEmoji = (value) => {
      for (
        const match of String(value || '').matchAll(
          /<(a?):([A-Za-z0-9_]{2,32}):(\d{16,22})>/g,
        )
      ) {
        const extension = match[1] === 'a' ? 'gif' : 'webp';

        assetUrls.add(
          `https://cdn.discordapp.com/emojis/${match[3]}.${extension}?size=64&quality=lossless`,
        );
      }
    };

    scanEmoji(message.content);

    for (const embed of message.embeds || []) {
      scanEmoji(embed.title);
      scanEmoji(embed.description);
      scanEmoji(embed.footer?.text);
      scanEmoji(embed.author?.name);

      for (const field of embed.fields || []) {
        scanEmoji(field.name);
        scanEmoji(field.value);
      }
    }
  };

  for (const message of relevantMessages) addMessageAssets(message);

  for (const style of userStyles.values()) {
    if (style.roleIconUrl) assetUrls.add(style.roleIconUrl);
  }

  for (const style of roleStyles.values()) {
    if (style.roleIconUrl) assetUrls.add(style.roleIconUrl);
  }

  const assetDataUrls = new Map();

  const downloads = await mapTranscriptWithConcurrency(
    [...assetUrls],
    5,
    async (url) => [url, await downloadTranscriptAsset(url)],
  );

  for (const [url, dataUrl] of downloads) {
    if (dataUrl) assetDataUrls.set(url, dataUrl);
  }

  return {
    userNames,
    userStyles,
    roleNames,
    roleStyles,
    channelNames,
    messagesById,
    replyMessages,
    assetDataUrls,
  };
}

function renderTranscriptRoleIcon(
  context,
  {
    roleIconUrl = null,
    roleUnicodeEmoji = null,
  } = {},
  className = 'role-icon',
) {
  if (roleIconUrl) {
    const src = transcriptAssetSource(context, roleIconUrl);

    return (
      `<img class="${escapeHtml(className)}" ` +
      `src="${escapeHtml(src)}" alt="Role icon" loading="lazy">`
    );
  }

  if (roleUnicodeEmoji) {
    return (
      `<span class="${escapeHtml(className)} unicode-role-icon">` +
      `${escapeHtml(roleUnicodeEmoji)}</span>`
    );
  }

  return '';
}


function renderTranscriptCustomEmoji(
  animated,
  name,
  id,
  context = null,
) {
  const extension = animated ? 'gif' : 'webp';

  const url =
    `https://cdn.discordapp.com/emojis/${id}.${extension}` +
    '?size=64&quality=lossless';

  const src = transcriptAssetSource(context, url);

  return (
    `<img class="custom-emoji" ` +
    `src="${escapeHtml(src)}" ` +
    `alt=":${escapeHtml(name)}:" ` +
    `title=":${escapeHtml(name)}:" ` +
    `loading="lazy">`
  );
}

function renderTranscriptTimestamp(unixSeconds, style = 'f') {
  const milliseconds = Number(unixSeconds) * 1000;
  const date = new Date(milliseconds);

  if (Number.isNaN(date.getTime())) {
    return escapeHtml(`<t:${unixSeconds}:${style}>`);
  }

  let formatted;

  if (style === 'R') {
    formatted = date.toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } else if (style === 't') {
    formatted = date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } else if (style === 'T') {
    formatted = date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } else if (style === 'd') {
    formatted = date.toLocaleDateString('en-GB');
  } else {
    formatted = date.toLocaleString('en-GB', {
      dateStyle: style === 'D' ? 'long' : 'medium',
      timeStyle:
        style === 'D'
          ? undefined
          : 'short',
    });
  }

  return `<span class="discord-timestamp">${escapeHtml(formatted)}</span>`;
}

function normalizeTranscriptUrl(value) {
  const raw = String(value || '').trim();

  try {
    const candidate = /^www\./i.test(raw)
      ? `https://${raw}`
      : raw;

    const parsed = new URL(candidate);

    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function renderTranscriptLink(
  url,
  labelHtml = null,
  {
    masked = false,
  } = {},
) {
  const safeUrl = normalizeTranscriptUrl(url);

  if (!safeUrl) {
    return labelHtml || escapeHtml(url);
  }

  const visible =
    labelHtml ||
    escapeHtml(
      /^www\./i.test(String(url))
        ? String(url)
        : safeUrl,
    );

  return (
    `<a class="md-link${masked ? ' masked-link' : ''}" ` +
    `href="${escapeHtml(safeUrl)}" ` +
    `target="_blank" rel="noopener noreferrer">${visible}</a>`
  );
}

function renderTranscriptLeaf(message, value, context) {
  const content = String(value || '');

  if (!content) return '';

  // Discord-specific tokens + normal URLs. Markdown itself is parsed by
  // renderTranscriptInline before reaching this leaf renderer.
  const tokenRegex =
    /<(a?):([A-Za-z0-9_]{2,32}):(\d{16,22})>|<@!?(\d{16,22})>|<@&(\d{16,22})>|<#(\d{16,22})>|<t:(\d{1,12})(?::([tTdDfFR]))?>|<(https?:\/\/[^>\s]+)>|@(everyone|here)|https?:\/\/[^\s<]+|www\.[^\s<]+/gi;

  let output = '';
  let lastIndex = 0;

  for (const match of content.matchAll(tokenRegex)) {
    output += escapeHtml(
      content.slice(lastIndex, match.index),
    );

    const full = match[0];

    if (match[3]) {
      output += renderTranscriptCustomEmoji(
        match[1] === 'a',
        match[2],
        match[3],
        context,
      );
    } else if (match[4]) {
      const userId = match[4];
      const user =
        message.mentions?.users?.get(userId);
      const member =
        message.guild?.members?.cache?.get(userId);

      const name =
        context?.userNames?.get(userId) ||
        member?.displayName ||
        user?.globalName ||
        user?.username ||
        `User ${userId}`;

      const userStyle = context?.userStyles?.get(userId) || {};

      output +=
        `<span class="mention user-mention" ` +
        `style="${escapeHtml(getTranscriptMentionStyle(userStyle))}" ` +
        `title="User ID: ${escapeHtml(userId)}">` +
        `@${escapeHtml(name)}</span>`;
    } else if (match[5]) {
      const roleId = match[5];
      const role =
        message.mentions?.roles?.get(roleId) ||
        message.guild?.roles?.cache?.get(roleId);

      const name =
        context?.roleNames?.get(roleId) ||
        role?.name ||
        `Role ${roleId}`;

      const roleStyle = context?.roleStyles?.get(roleId) || {};
      const roleIcon = renderTranscriptRoleIcon(
        context,
        roleStyle,
        'mention-role-icon',
      );

      output +=
        `<span class="mention role-mention" ` +
        `style="${escapeHtml(getTranscriptMentionStyle(roleStyle))}" ` +
        `title="Role ID: ${escapeHtml(roleId)}">` +
        `${roleIcon}@${escapeHtml(name)}</span>`;
    } else if (match[6]) {
      const channelId = match[6];
      const mentionedChannel =
        message.mentions?.channels?.get(channelId) ||
        message.guild?.channels?.cache?.get(channelId);

      const name =
        context?.channelNames?.get(channelId) ||
        mentionedChannel?.name ||
        `channel-${channelId}`;

      output +=
        `<span class="mention channel-mention" ` +
        `title="Channel ID: ${escapeHtml(channelId)}">` +
        `#${escapeHtml(name)}</span>`;
    } else if (match[7]) {
      output += renderTranscriptTimestamp(
        match[7],
        match[8] || 'f',
      );
    } else if (match[9]) {
      output += renderTranscriptLink(
        match[9],
        escapeHtml(match[9]),
      );
    } else if (match[10]) {
      output +=
        `<span class="mention everyone-mention">` +
        `@${escapeHtml(match[10])}</span>`;
    } else {
      // Trim punctuation Discord would normally leave outside a bare link.
      let urlText = full;
      let trailing = '';

      while (
        /[.,!?;:]$/.test(urlText)
      ) {
        trailing =
          urlText.slice(-1) +
          trailing;
        urlText = urlText.slice(0, -1);
      }

      output +=
        renderTranscriptLink(urlText) +
        escapeHtml(trailing);
    }

    lastIndex = match.index + full.length;
  }

  output += escapeHtml(content.slice(lastIndex));

  return output;
}

function findNextTranscriptInlineToken(content) {
  const patterns = [
    {
      type: 'escape',
      regex: /\\([\\`*_{}\[\]()#+\-.!|>~])/,
    },
    {
      type: 'code',
      regex: /`([^`\n]+)`/,
    },
    {
      type: 'maskedLink',
      regex: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/i,
    },
    {
      type: 'boldItalic',
      regex: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/,
    },
    {
      type: 'underlineItalic',
      regex: /___(?=\S)([\s\S]*?\S)___/,
    },
    {
      type: 'bold',
      regex: /\*\*(?=\S)([\s\S]*?\S)\*\*/,
    },
    {
      type: 'underline',
      regex: /__(?=\S)([\s\S]*?\S)__/,
    },
    {
      type: 'strike',
      regex: /~~(?=\S)([\s\S]*?\S)~~/,
    },
    {
      type: 'spoiler',
      regex: /\|\|(?=\S)([\s\S]*?\S)\|\|/,
    },
    {
      type: 'italicStar',
      regex: /\*(?!\*)(?=\S)([^*\n]*?\S)\*/,
    },
    {
      type: 'italicUnderscore',
      regex: /(^|[^\w])_(?!_)(?=\S)([^_\n]*?\S)_(?!\w)/,
    },
  ];

  let best = null;

  for (let priority = 0; priority < patterns.length; priority += 1) {
    const definition = patterns[priority];
    const match = definition.regex.exec(content);

    if (!match) continue;

    if (
      !best ||
      match.index < best.match.index ||
      (
        match.index === best.match.index &&
        priority < best.priority
      )
    ) {
      best = {
        ...definition,
        match,
        priority,
      };
    }
  }

  return best;
}

function renderTranscriptInline(
  message,
  value,
  context,
  depth = 0,
) {
  const content = String(value || '');

  if (!content) return '';

  // Prevent pathological nested markdown from causing excessive recursion.
  if (depth >= 10) {
    return renderTranscriptLeaf(
      message,
      content,
      context,
    );
  }

  let output = '';
  let remaining = content;

  while (remaining) {
    const token = findNextTranscriptInlineToken(remaining);

    if (!token) {
      output += renderTranscriptLeaf(
        message,
        remaining,
        context,
      );
      break;
    }

    output += renderTranscriptLeaf(
      message,
      remaining.slice(0, token.match.index),
      context,
    );

    const match = token.match;

    if (token.type === 'escape') {
      output += escapeHtml(match[1]);
    } else if (token.type === 'code') {
      output +=
        `<code class="inline-code">${escapeHtml(match[1])}</code>`;
    } else if (token.type === 'maskedLink') {
      output += renderTranscriptLink(
        match[2],
        renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        ),
        { masked: true },
      );
    } else if (token.type === 'boldItalic') {
      output +=
        `<strong><em>${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</em></strong>`;
    } else if (token.type === 'underlineItalic') {
      output +=
        `<u><em>${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</em></u>`;
    } else if (token.type === 'bold') {
      output +=
        `<strong>${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</strong>`;
    } else if (token.type === 'underline') {
      output +=
        `<u>${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</u>`;
    } else if (token.type === 'strike') {
      output +=
        `<s>${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</s>`;
    } else if (token.type === 'spoiler') {
      output +=
        `<span class="spoiler" title="Discord spoiler">${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</span>`;
    } else if (token.type === 'italicStar') {
      output +=
        `<em>${renderTranscriptInline(
          message,
          match[1],
          context,
          depth + 1,
        )}</em>`;
    } else if (token.type === 'italicUnderscore') {
      // This regex includes the character immediately before the underscore so
      // underscores inside normal words do not accidentally become italics.
      output +=
        renderTranscriptLeaf(
          message,
          match[1],
          context,
        ) +
        `<em>${renderTranscriptInline(
          message,
          match[2],
          context,
          depth + 1,
        )}</em>`;
    }

    remaining = remaining.slice(
      match.index + match[0].length,
    );
  }

  return output;
}

function renderTranscriptMarkdownLines(
  message,
  value,
  context,
) {
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.length) {
      output.push('<div class="md-spacer"></div>');
      continue;
    }

    // Discord multi-line block quote: >>> quote text
    if (/^>>>\s?/.test(line)) {
      const firstLine = line.replace(/^>>>\s?/, '');
      const rest = [
        firstLine,
        ...lines.slice(index + 1),
      ].join('\n');

      output.push(
        `<blockquote class="md-quote multi-quote">${renderTranscriptMarkdownLines(
          message,
          rest,
          context,
        )}</blockquote>`,
      );
      break;
    }

    // Consecutive single-line quotes.
    if (/^>\s?/.test(line)) {
      const quoteLines = [];

      while (
        index < lines.length &&
        /^>\s?/.test(lines[index])
      ) {
        quoteLines.push(
          lines[index].replace(/^>\s?/, ''),
        );
        index += 1;
      }

      index -= 1;

      output.push(
        `<blockquote class="md-quote">${quoteLines
          .map(
            (quoteLine) =>
              `<div class="md-line">${renderTranscriptInline(
                message,
                quoteLine,
                context,
              )}</div>`,
          )
          .join('')}</blockquote>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);

    if (heading) {
      const level = heading[1].length;

      output.push(
        `<h${level + 2} class="md-heading md-h${level}">${renderTranscriptInline(
          message,
          heading[2],
          context,
        )}</h${level + 2}>`,
      );
      continue;
    }

    const subtext = line.match(/^-#\s+(.+)$/);

    if (subtext) {
      output.push(
        `<div class="md-subtext">${renderTranscriptInline(
          message,
          subtext[1],
          context,
        )}</div>`,
      );
      continue;
    }

    const unordered = line.match(/^(\s*)[-+*]\s+(.+)$/);

    if (unordered) {
      const depth = Math.min(
        4,
        Math.floor(unordered[1].length / 2),
      );

      output.push(
        `<div class="md-list-item" style="--list-depth:${depth}">` +
        `<span class="md-list-marker">•</span>` +
        `<span>${renderTranscriptInline(
          message,
          unordered[2],
          context,
        )}</span></div>`,
      );
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);

    if (ordered) {
      const depth = Math.min(
        4,
        Math.floor(ordered[1].length / 2),
      );

      output.push(
        `<div class="md-list-item" style="--list-depth:${depth}">` +
        `<span class="md-list-marker">${escapeHtml(
          ordered[2],
        )}.</span>` +
        `<span>${renderTranscriptInline(
          message,
          ordered[3],
          context,
        )}</span></div>`,
      );
      continue;
    }

    output.push(
      `<div class="md-line">${renderTranscriptInline(
        message,
        line,
        context,
      )}</div>`,
    );
  }

  return output.join('');
}

function renderTranscriptMarkdown(message, value, context) {
  const content = String(value || '')
    .replace(/\r\n?/g, '\n');

  if (!content) return '';

  // Fenced code blocks are processed before normal Discord markdown. Nothing
  // inside a code block should be interpreted as mentions, emoji, links, etc.
  const fenceRegex =
    /```([A-Za-z0-9_+#.-]*)[ \t]*\n?([\s\S]*?)```/g;

  let output = '';
  let lastIndex = 0;

  for (const match of content.matchAll(fenceRegex)) {
    output += renderTranscriptMarkdownLines(
      message,
      content.slice(lastIndex, match.index),
      context,
    );

    const language = String(match[1] || '').trim();
    const code = match[2] || '';

    output +=
      `<div class="code-block-wrap">` +
      (
        language
          ? `<div class="code-language">${escapeHtml(language)}</div>`
          : ''
      ) +
      `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>` +
      `</div>`;

    lastIndex = match.index + match[0].length;
  }

  output += renderTranscriptMarkdownLines(
    message,
    content.slice(lastIndex),
    context,
  );

  return output;
}

function renderTranscriptRichText(message, value, context) {
  return renderTranscriptInline(
    message,
    value,
    context,
  );
}

function formatTranscriptContent(message, context) {
  return renderTranscriptMarkdown(
    message,
    message.content || '',
    context,
  );
}


function renderTranscriptEmbeds(message, context) {
  if (!message.embeds?.length) return '';

  return message.embeds.map((embed) => {
    const author = embed.author?.name
      ? `<div class="embed-author">${renderTranscriptRichText(
          message,
          embed.author.name,
          context,
        )}</div>`
      : '';

    const title = embed.title
      ? `<div class="embed-title">${renderTranscriptRichText(
          message,
          embed.title,
          context,
        )}</div>`
      : '';

    const description = embed.description
      ? `<div class="embed-description">${renderTranscriptMarkdown(
          message,
          embed.description,
          context,
        )}</div>`
      : '';

    const fields = embed.fields?.length
      ? `<div class="embed-fields">${embed.fields.map((field) => `
          <div class="embed-field">
            <div class="embed-field-name">${renderTranscriptRichText(
              message,
              field.name,
              context,
            )}</div>
            <div class="embed-field-value">${renderTranscriptMarkdown(
              message,
              field.value,
              context,
            )}</div>
          </div>`).join('')}</div>`
      : '';

    const thumbnail = embed.thumbnail?.url
      ? (() => {
          const src = transcriptAssetSource(context, embed.thumbnail.url);
          return `<a class="embed-thumb-link" href="${escapeHtml(src)}" target="_blank" rel="noreferrer">
            <img class="embed-thumb" src="${escapeHtml(src)}" alt="Embed thumbnail" loading="lazy">
          </a>`;
        })()
      : '';

    const image = embed.image?.url
      ? (() => {
          const src = transcriptAssetSource(context, embed.image.url);
          return `<a class="embed-image-link" href="${escapeHtml(src)}" target="_blank" rel="noreferrer">
            <img class="embed-image" src="${escapeHtml(src)}" alt="Embed image" loading="lazy">
          </a>`;
        })()
      : '';

    const footer = embed.footer?.text
      ? `<div class="embed-footer">${renderTranscriptRichText(
          message,
          embed.footer.text,
          context,
        )}</div>`
      : '';

    return `
      <div class="discord-embed">
        ${thumbnail}
        <div class="embed-main">
          ${author}
          ${title}
          ${description}
          ${fields}
          ${image}
          ${footer}
        </div>
      </div>`;
  }).join('');
}

function isTranscriptImageAttachment(attachment) {
  const contentType = String(
    attachment.contentType || '',
  ).toLowerCase();

  if (contentType.startsWith('image/')) {
    return true;
  }

  return /\.(png|jpe?g|gif|webp|avif)$/i.test(
    String(attachment.name || ''),
  );
}

function renderTranscriptAttachments(message, context) {
  if (!message.attachments?.size) return '';

  return [...message.attachments.values()]
    .map((attachment) => {
      const name = escapeHtml(attachment.name || 'attachment');
      const originalUrl = attachment.url || attachment.proxyURL || '';
      const renderedUrl = transcriptAssetSource(context, originalUrl);
      const safeRenderedUrl = escapeHtml(renderedUrl);
      const isImage = isTranscriptImageAttachment(attachment);

      if (isImage) {
        return `
          <div class="attachment image-attachment">
            <a class="attachment-name" href="${safeRenderedUrl}" target="_blank" rel="noreferrer">${name}</a>
            <a class="attachment-image-link" href="${safeRenderedUrl}" target="_blank" rel="noreferrer">
              <img
                class="attachment-image"
                src="${safeRenderedUrl}"
                alt="${name}"
                loading="lazy"
              >
            </a>
          </div>`;
      }

      return `
        <div class="attachment file-attachment">
          <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noreferrer">${name}</a>
        </div>`;
    })
    .join('');
}

function renderTranscriptStickers(message, context) {
  if (!message.stickers?.size) return '';

  return `
    <div class="stickers">
      ${[...message.stickers.values()]
        .map((sticker) => {
          const name = escapeHtml(
            sticker.name || 'Sticker',
          );
          const originalUrl = sticker.url || '';

          if (!originalUrl) {
            return `<span class="sticker-name">${name}</span>`;
          }

          const url = escapeHtml(
            transcriptAssetSource(context, originalUrl),
          );

          return `
            <a class="sticker-link" href="${url}" target="_blank" rel="noreferrer" title="${name}">
              <img class="sticker-image" src="${url}" alt="${name}" loading="lazy">
            </a>`;
        })
        .join('')}
    </div>`;
}

function renderReactionEmoji(reaction, context) {
  const emoji = reaction.emoji;

  if (emoji?.id) {
    return renderTranscriptCustomEmoji(
      Boolean(emoji.animated),
      emoji.name || 'emoji',
      emoji.id,
      context,
    );
  }

  return `<span class="unicode-reaction">${escapeHtml(
    emoji?.name || '❔',
  )}</span>`;
}

function renderTranscriptReactions(message, context) {
  const reactions = message.reactions?.cache;

  if (!reactions?.size) return '';

  return `
    <div class="reactions">
      ${[...reactions.values()]
        .map(
          (reaction) => `
            <span class="reaction">
              ${renderReactionEmoji(reaction, context)}
              <span class="reaction-count">${Number(
                reaction.count,
              ) || 0}</span>
            </span>`,
        )
        .join('')}
    </div>`;
}

async function fetchAllChannelMessages(channel) {
  const messages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      before,
      cache: false,
    });

    if (!batch.size) break;

    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function getClosedByIdFromControlMessage(message) {
  const description = message?.embeds?.[0]?.description || '';
  const match = description.match(/Ticket Closed by <@!?(\d+)>/i);
  return match ? match[1] : null;
}

function getClosedAtFromControlMessage(message) {
  const timestamp =
    Number(message?.createdTimestamp) ||
    Number(message?.createdAt?.getTime?.());

  if (!Number.isFinite(timestamp)) return null;

  return new Date(timestamp).toISOString();
}

function normalizedClaimHistory(data) {
  const history = Array.isArray(data?.claimHistory)
    ? data.claimHistory
        .map((entry) => ({
          userId: entry?.userId ? String(entry.userId) : null,
          claimedAt: entry?.claimedAt ? String(entry.claimedAt) : null,
          previousClaimedById: entry?.previousClaimedById
            ? String(entry.previousClaimedById)
            : null,
          action:
            entry?.action === 'handover'
              ? 'handover'
              : entry?.action === 'takeover'
                ? 'takeover'
                : 'claim',
        }))
        .filter((entry) => entry.userId)
    : [];

  // Backward compatibility for legacy claimed tickets.
  if (!history.length && data?.claimedById) {
    history.push({
      userId: String(data.claimedById),
      claimedAt: null,
      previousClaimedById: null,
      action: 'claim',
    });
  }

  return history;
}

function normalizedAssistHistory(data) {
  return Array.isArray(
    data?.assistHistory,
  )
    ? data.assistHistory
        .map((entry) => ({
          staffId:
            entry?.staffId
              ? String(
                  entry.staffId,
                )
              : null,
          addedById:
            entry?.addedById
              ? String(
                  entry.addedById,
                )
              : null,
          addedAt:
            entry?.addedAt
              ? String(
                  entry.addedAt,
                )
              : null,
        }))
        .filter(
          (entry) =>
            entry.staffId,
        )
    : [];
}

function normalizedHandoverHistory(data) {
  return Array.isArray(
    data?.handoverHistory,
  )
    ? data.handoverHistory
        .map((entry) => ({
          requestId:
            entry?.requestId
              ? String(
                  entry.requestId,
                )
              : null,
          fromStaffId:
            entry?.fromStaffId
              ? String(
                  entry.fromStaffId,
                )
              : null,
          toStaffId:
            entry?.toStaffId
              ? String(
                  entry.toStaffId,
                )
              : null,
          requestedAt:
            entry?.requestedAt
              ? String(
                  entry.requestedAt,
                )
              : null,
          acceptedAt:
            entry?.acceptedAt
              ? String(
                  entry.acceptedAt,
                )
              : null,
          status:
            entry?.status ===
              'accepted'
              ? 'accepted'
              : 'pending',
        }))
        .filter(
          (entry) =>
            entry.fromStaffId &&
            entry.toStaffId,
        )
    : [];
}

async function getTranscriptUserLabel(guild, userId) {
  if (!userId) return 'Unknown';

  const member =
    guild.members.cache.get(String(userId)) ||
    (await guild.members.fetch(String(userId)).catch(() => null));

  const user = member?.user;

  const display =
    member?.displayName ||
    user?.globalName ||
    user?.username ||
    `User ${userId}`;

  return `@${display}`;
}

function formatAuditDate(value) {
  if (!value) return 'Time unavailable';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';

  return date.toLocaleString('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    hour12: false,
  });
}

async function buildTranscriptAuditData(
  channel,
  data,
  {
    transcriptCreatedByUser = null,
    closedById = null,
    closedAt = null,
  } = {},
) {
  const claimHistory =
    normalizedClaimHistory(
      data,
    );

  const assistHistory =
    normalizedAssistHistory(
      data,
    );

  const handoverHistory =
    normalizedHandoverHistory(
      data,
    );

  const currentAssistants =
    Array.isArray(
      data?.assistStaffIds,
    )
      ? [
          ...new Set(
            data.assistStaffIds.map(
              String,
            ),
          ),
        ]
      : [];

  const ids =
    new Set();

  for (
    const entry of
    claimHistory
  ) {
    if (entry.userId) {
      ids.add(
        entry.userId,
      );
    }
    if (
      entry.previousClaimedById
    ) {
      ids.add(
        entry.previousClaimedById,
      );
    }
  }

  for (
    const entry of
    assistHistory
  ) {
    if (entry.staffId) {
      ids.add(
        entry.staffId,
      );
    }
    if (entry.addedById) {
      ids.add(
        entry.addedById,
      );
    }
  }

  for (
    const entry of
    handoverHistory
  ) {
    ids.add(
      entry.fromStaffId,
    );
    ids.add(
      entry.toStaffId,
    );
  }

  for (
    const assistantId of
    currentAssistants
  ) {
    ids.add(
      assistantId,
    );
  }

  if (data?.deletionRequestedById) ids.add(String(data.deletionRequestedById));

  if (data?.claimedById) {
    ids.add(
      String(
        data.claimedById,
      ),
    );
  }

  if (closedById) {
    ids.add(
      String(
        closedById,
      ),
    );
  }

  if (
    transcriptCreatedByUser?.id
  ) {
    ids.add(
      String(
        transcriptCreatedByUser.id,
      ),
    );
  }

  const labels =
    new Map();

  await Promise.all(
    [...ids].map(
      async (userId) => {
        labels.set(
          String(userId),
          await getTranscriptUserLabel(
            channel.guild,
            userId,
          ),
        );
      },
    ),
  );

  const firstClaim =
    claimHistory.find(
      (entry) =>
        entry.action ===
          'claim',
    ) ||
    claimHistory[0] ||
    null;

  const finalClaim =
    claimHistory[
      claimHistory.length - 1
    ] ||
    null;

  return {
    firstClaim,
    finalClaim,
    currentClaimedById:
      data?.claimedById ||
      finalClaim?.userId ||
      null,
    claimHistory,
    assistHistory,
    handoverHistory,
    currentAssistants,
    closedById:
      closedById ||
      data?.closedById ||
      null,
    closedAt:
      closedAt ||
      data?.closedAt ||
      null,
    transcriptCreatedById:
      transcriptCreatedByUser?.id ||
      null,
    deletionRequestedById: data.deletionRequestedById || null,
    deletionMethod: data.deletionMethod || null,
    labels,
  };
}

function renderTranscriptAuditHtml(
  audit,
  data,
) {
  const isClaimNotApplicable =
    data.typeKey ===
    'report_staff';

  const label =
    (userId) =>
      userId
        ? audit.labels.get(
            String(
              userId,
            ),
          ) ||
          `User ${userId}`
        : 'Unclaimed';

  const firstClaimedBy =
    isClaimNotApplicable
      ? 'Not applicable'
      : audit.firstClaim
        ? label(
            audit.firstClaim
              .userId,
          )
        : 'Unclaimed';

  const firstClaimedAt =
    isClaimNotApplicable
      ? 'Not applicable'
      : audit.firstClaim
        ? formatAuditDate(
            audit.firstClaim
              .claimedAt,
          )
        : 'Not claimed';

  const currentClaimer =
    isClaimNotApplicable
      ? 'Not applicable'
      : audit.currentClaimedById
        ? label(
            audit.currentClaimedById,
          )
        : 'Unclaimed';

  const currentAssistants =
    isClaimNotApplicable
      ? 'Not applicable'
      : audit.currentAssistants
          .length
        ? audit.currentAssistants
            .map(
              (id) =>
                label(id),
            )
            .join(', ')
        : 'None';

  const transcriptCreatedBy =
    audit.transcriptCreatedById
      ? label(
          audit.transcriptCreatedById,
        )
      : 'Unknown';

  const closedBy =
    audit.closedById
      ? label(
          audit.closedById,
        )
      : 'Unknown';

  const closedAt =
    audit.closedAt
      ? formatAuditDate(
          audit.closedAt,
        )
      : 'Time unavailable';

  const ownershipHtml =
    isClaimNotApplicable
      ? '<div class="claim-empty">Claiming / handover is not used for this ticket type.</div>'
      : audit.claimHistory.length
        ? audit.claimHistory
            .map(
              (entry, index) => {
                const actionLabel =
                  entry.action ===
                    'handover'
                    ? 'Handover accepted'
                    : entry.action ===
                        'takeover'
                      ? 'Legacy takeover'
                      : index === 0
                        ? 'First claim'
                        : 'Claim';

                const previous =
                  entry.previousClaimedById
                    ? `<span class="claim-from">from ${escapeHtml(
                        label(
                          entry.previousClaimedById,
                        ),
                      )}</span>`
                    : '';

                return `
              <div class="claim-row">
                <div class="claim-index">${index + 1}</div>
                <div class="claim-main">
                  <b>${escapeHtml(actionLabel)} — ${escapeHtml(
                    label(entry.userId),
                  )}</b>
                  ${previous}
                  <span>${escapeHtml(formatAuditDate(entry.claimedAt))}</span>
                </div>
              </div>`;
              },
            )
            .join('\n')
        : '<div class="claim-empty">This ticket was never claimed.</div>';

  const assistHtml =
    isClaimNotApplicable
      ? '<div class="claim-empty">Assist is not used for this ticket type.</div>'
      : audit.assistHistory
          .length
        ? audit.assistHistory
            .map(
              (entry, index) => `
              <div class="claim-row">
                <div class="claim-index">${index + 1}</div>
                <div class="claim-main">
                  <b>Assistant added — ${escapeHtml(label(entry.staffId))}</b>
                  <span>by ${escapeHtml(label(entry.addedById))}</span>
                  <span>${escapeHtml(formatAuditDate(entry.addedAt))}</span>
                </div>
              </div>`,
            )
            .join('\n')
        : '<div class="claim-empty">No assistants were added.</div>';

  const handoverHtml =
    isClaimNotApplicable
      ? '<div class="claim-empty">Handover is not used for this ticket type.</div>'
      : audit.handoverHistory
          .length
        ? audit.handoverHistory
            .map(
              (entry, index) => `
              <div class="claim-row">
                <div class="claim-index">${index + 1}</div>
                <div class="claim-main">
                  <b>Handover ${escapeHtml(entry.status)} — ${escapeHtml(
                    label(entry.fromStaffId),
                  )} → ${escapeHtml(label(entry.toStaffId))}</b>
                  <span>Requested ${escapeHtml(formatAuditDate(entry.requestedAt))}</span>
                  ${
                    entry.acceptedAt
                      ? `<span>Accepted ${escapeHtml(formatAuditDate(entry.acceptedAt))}</span>`
                      : ''
                  }
                </div>
              </div>`,
            )
            .join('\n')
        : '<div class="claim-empty">No handover requests were made.</div>';

  return `
  <section class="audit-card">
    <h2>Ticket Audit</h2>
    <div class="audit-grid">
      <div class="audit-item"><span>Claimed By (First)</span><b>${escapeHtml(firstClaimedBy)}</b></div>
      <div class="audit-item"><span>First Claimed At</span><b>${escapeHtml(firstClaimedAt)}</b></div>
      <div class="audit-item"><span>Current / Final Owner</span><b>${escapeHtml(currentClaimer)}</b></div>
      <div class="audit-item"><span>Current Assistants</span><b>${escapeHtml(currentAssistants)}</b></div>
      <div class="audit-item"><span>Transcript Created By</span><b>${escapeHtml(transcriptCreatedBy)}</b></div>
      ${audit.deletionRequestedById ? `<div class="audit-item"><span>Deletion Requested By</span><b>${escapeHtml(label(audit.deletionRequestedById))}</b><div class="audit-date">${escapeHtml(audit.deletionMethod || 'Unknown')} • Archived before deletion</div></div>` : ''}
      <div class="audit-item">
        <span>Ticket Closed By</span>
        <b>${escapeHtml(closedBy)}</b>
        <div class="audit-date">${escapeHtml(closedAt)}</div>
      </div>
      <div class="audit-item"><span>Ownership Events</span><b>${isClaimNotApplicable ? 'N/A' : audit.claimHistory.length}</b></div>
      <div class="audit-item"><span>Assist Additions</span><b>${isClaimNotApplicable ? 'N/A' : audit.assistHistory.length}</b></div>
      <div class="audit-item"><span>Handover Requests</span><b>${isClaimNotApplicable ? 'N/A' : audit.handoverHistory.length}</b></div>
    </div>

    <h3>Claim / Handover Ownership History</h3>
    <div class="claim-history">
      ${ownershipHtml}
    </div>

    <h3>Assistant History</h3>
    <div class="claim-history">
      ${assistHtml}
    </div>

    <h3>Handover Requests</h3>
    <div class="claim-history">
      ${handoverHtml}
    </div>
  </section>`;
}

function getTranscriptReplyPreviewText(message) {
  const content = String(message?.content || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (content) {
    return content.length > 220
      ? `${content.slice(0, 219)}…`
      : content;
  }

  if (message?.attachments?.size) {
    const first = [...message.attachments.values()][0];

    return isTranscriptImageAttachment(first)
      ? '📷 Image attachment'
      : `📎 ${first?.name || 'Attachment'}`;
  }

  if (message?.stickers?.size) {
    const first = [...message.stickers.values()][0];
    return `🎟️ Sticker: ${first?.name || 'Sticker'}`;
  }

  if (message?.embeds?.length) {
    const first = message.embeds[0];
    return first.title || first.description || 'Embedded message';
  }

  return 'Original message';
}

function renderTranscriptReplyPreview(message, context) {
  const referenceId = message.reference?.messageId || null;
  if (!referenceId) return '';

  const referenced =
    context?.replyMessages?.get(String(message.id)) ||
    context?.messagesById?.get(String(referenceId)) ||
    null;

  if (!referenced) {
    return `
      <div class="reply-preview reply-missing">
        <span class="reply-connector"></span>
        <span class="reply-unavailable">Original message unavailable</span>
      </div>`;
  }

  const author = referenced.author;
  const authorId = String(author?.id || '');

  const displayName =
    referenced.member?.displayName ||
    context?.userNames?.get(authorId) ||
    author?.globalName ||
    author?.username ||
    'Unknown User';

  const rawAvatar =
    author?.displayAvatarURL?.({
      extension: 'png',
      size: 64,
    }) || '';

  const avatar = transcriptAssetSource(context, rawAvatar);

  const style =
    context?.userStyles?.get(authorId) ||
    getTranscriptMemberStyle(referenced.member);

  const roleIcon = renderTranscriptRoleIcon(
    context,
    style,
    'reply-role-icon',
  );

  const previewText = getTranscriptReplyPreviewText(referenced);

  const jumpTarget = context?.messagesById?.has(String(referenceId))
    ? `#message-${referenceId}`
    : null;

  const openTag = jumpTarget
    ? `<a class="reply-preview" href="${escapeHtml(jumpTarget)}" title="Jump to replied message">`
    : '<div class="reply-preview">';

  const closeTag = jumpTarget ? '</a>' : '</div>';

  return `
    ${openTag}
      <span class="reply-connector"></span>
      ${
        avatar
          ? `<img class="reply-avatar" src="${escapeHtml(avatar)}" alt="">`
          : '<span class="reply-avatar reply-avatar-fallback"></span>'
      }
      <span class="reply-author" style="${escapeHtml(
        getTranscriptNameStyle(style),
      )}">${escapeHtml(displayName)}</span>
      ${roleIcon}
      <span class="reply-text">${renderTranscriptInline(
        referenced,
        previewText,
        context,
      )}</span>
    ${closeTag}`;
}

function buildTranscriptHtml(channel, data, messages, audit, renderContext) {
  const type = TICKET_TYPES[data.typeKey] || { label: data.typeKey };
  const generatedAt = new Date();
  const participantIds = new Set(
    messages
      .filter((message) => !message.author?.bot)
      .map((message) => message.author?.id)
      .filter(Boolean),
  );

  const messageHtml = messages
    .filter((message) => message.type !== MessageType.ChannelPinnedMessage)
    .map((message) => {
      const author = message.author;
      const displayName =
        message.member?.displayName ||
        author?.globalName ||
        author?.username ||
        'Unknown User';
      const username = author?.username || 'unknown';
      const rawAvatar =
        author?.displayAvatarURL({
          extension: 'png',
          size: 128,
        }) || '';

      const avatar = transcriptAssetSource(renderContext, rawAvatar);

      const timestamp = new Date(message.createdTimestamp).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'medium',
      });
      const content = formatTranscriptContent(message, renderContext);
      const edited = message.editedTimestamp ? '<span class="edited">(edited)</span>' : '';
      const botBadge = author?.bot ? '<span class="bot-badge">BOT</span>' : '';

      const authorId = String(author?.id || '');

      const memberStyle =
        renderContext?.userStyles?.get(authorId) ||
        getTranscriptMemberStyle(message.member);

      const roleIcon = renderTranscriptRoleIcon(
        renderContext,
        memberStyle,
        'message-role-icon',
      );

      const replyPreview = renderTranscriptReplyPreview(
        message,
        renderContext,
      );

      return `
        <article class="message" id="message-${escapeHtml(message.id)}">
          <img class="avatar" src="${escapeHtml(avatar)}" alt="">
          <div class="message-body">
            ${replyPreview}
            <div class="message-meta">
              <strong class="display-name" style="${escapeHtml(
                getTranscriptNameStyle(memberStyle),
              )}">${escapeHtml(displayName)}</strong>
              ${roleIcon}
              ${botBadge}
              <span class="username">@${escapeHtml(username)}</span>
              <time>${escapeHtml(timestamp)}</time>
              ${edited}
            </div>
            ${content ? `<div class="content">${content}</div>` : ''}
            ${renderTranscriptEmbeds(message, renderContext)}
            ${renderTranscriptAttachments(message, renderContext)}
            ${renderTranscriptStickers(message, renderContext)}
            ${renderTranscriptReactions(message, renderContext)}
          </div>
        </article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket #${escapeHtml(data.number)} Transcript</title>
<style>
  :root{color-scheme:dark;--bg:#111214;--panel:#1e1f22;--panel2:#2b2d31;--text:#dbdee1;--muted:#949ba4;--accent:#5865f2;--green:#23a55a;--border:#3f4147}
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,#0b0c0e,#16171a);color:var(--text);font:15px/1.45 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}
  .shell{max-width:1100px;margin:0 auto;padding:32px 18px 60px}
  .hero{background:linear-gradient(135deg,#24262b,#191a1e);border:1px solid var(--border);border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(0,0,0,.3)}
  .hero h1{margin:0 0 8px;font-size:28px}
  .subtitle{color:var(--muted);margin-bottom:20px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
  .stat{background:#111214;border:1px solid #313338;border-radius:12px;padding:12px}
  .stat b{display:block;color:#fff;font-size:17px}.stat span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  .audit-card{margin-top:20px;background:#1b1c20;border:1px solid var(--border);border-left:5px solid #f0b232;border-radius:16px;padding:20px}
  .audit-card h2{margin:0 0 16px;font-size:22px;color:#fff}
  .audit-card h3{margin:20px 0 10px;font-size:16px;color:#fff}
  .audit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
  .audit-item{background:#111214;border:1px solid #313338;border-radius:10px;padding:12px}
  .audit-item span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
  .audit-item b{color:#fff;font-size:15px;overflow-wrap:anywhere}
  .audit-date{margin-top:5px;color:var(--muted);font-size:13px;line-height:1.35;overflow-wrap:anywhere}
  .claim-history{display:grid;gap:8px}
  .claim-row{display:flex;gap:12px;align-items:flex-start;background:#111214;border:1px solid #313338;border-radius:10px;padding:11px 12px}
  .claim-index{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#2b2d31;color:#fff;font-weight:800;flex:0 0 auto}
  .claim-main{display:flex;flex-wrap:wrap;gap:5px 9px;align-items:baseline;min-width:0}
  .claim-main b{color:#fff}.claim-main span{color:var(--muted);font-size:13px}
  .claim-from{color:#f0b232!important}
  .claim-empty{color:var(--muted);background:#111214;border:1px solid #313338;border-radius:10px;padding:12px}
  .messages{margin-top:20px;background:var(--panel);border:1px solid var(--border);border-radius:18px;overflow:hidden}
  .message{display:flex;gap:14px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.045)}
  .message:hover{background:#232428}
  .message:last-child{border-bottom:0}
  .avatar{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#313338;flex:0 0 auto}
  .message-body{min-width:0;flex:1}
  .message-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .message-meta strong{color:#f2f3f5}.display-name{font-weight:750;display:inline-block}.username,time,.edited{color:var(--muted);font-size:12px}
  .message-role-icon,.reply-role-icon,.mention-role-icon{display:inline-block;width:18px;height:18px;object-fit:contain;vertical-align:middle;flex:0 0 auto}
  .reply-role-icon,.mention-role-icon{width:16px;height:16px}.mention-role-icon{margin-right:3px}
  .unicode-role-icon{width:auto!important;height:auto!important;font-size:15px;line-height:1}
  .reply-preview{position:relative;display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;min-height:25px;margin:0 0 6px -50px;padding-left:50px;color:var(--muted);text-decoration:none;font-size:13px;line-height:1.3}
  a.reply-preview:hover .reply-text{text-decoration:underline;color:#dbdee1}
  .reply-connector{position:absolute;left:20px;top:13px;width:25px;height:17px;border-left:2px solid #4e5058;border-top:2px solid #4e5058;border-radius:8px 0 0 0}
  .reply-avatar{width:18px;height:18px;border-radius:50%;object-fit:cover;background:#313338;flex:0 0 auto}
  .reply-avatar-fallback{display:inline-block}.reply-author{font-weight:700;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
  .reply-text{color:#b5bac1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.reply-text .custom-emoji{width:18px;height:18px;vertical-align:-4px}
  .reply-missing{font-style:italic;color:#949ba4}.reply-unavailable{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bot-badge{font-size:10px;font-weight:800;background:var(--accent);padding:1px 5px;border-radius:4px;color:white}
  .content{white-space:normal;overflow-wrap:anywhere;word-break:break-word;margin-top:3px}
  .md-line{min-height:1.45em;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .md-spacer{height:.72em}
  .md-heading{color:#f2f3f5;margin:.45em 0 .2em;line-height:1.25;overflow-wrap:anywhere}
  .md-h1{font-size:1.45em}.md-h2{font-size:1.25em}.md-h3{font-size:1.08em}
  .md-subtext{color:var(--muted);font-size:.86em;margin:.12em 0;white-space:pre-wrap}
  .md-quote{display:block;margin:.3em 0;padding:2px 0 2px 12px;border-left:4px solid #4e5058;color:#dbdee1}
  .md-quote .md-quote{margin-left:8px}.multi-quote{white-space:normal}
  .md-list-item{display:flex;align-items:flex-start;gap:8px;padding-left:calc(var(--list-depth,0) * 18px);min-height:1.45em}
  .md-list-marker{min-width:18px;text-align:right;color:#dbdee1;flex:0 0 auto}
  strong{font-weight:800;color:#f2f3f5}em{font-style:italic}u{text-decoration:underline;text-underline-offset:2px}s{text-decoration:line-through}
  .inline-code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:.92em;background:#111214;color:#dbdee1;border-radius:4px;padding:2px 4px;white-space:pre-wrap;overflow-wrap:anywhere}
  .code-block-wrap{position:relative;margin:6px 0 8px;width:min(100%,900px)}
  .code-language{position:absolute;right:9px;top:7px;color:#949ba4;font:10px/1.2 "SFMono-Regular",Consolas,monospace;text-transform:uppercase;letter-spacing:.06em}
  .code-block{margin:0;padding:12px 14px;background:#111214;border:1px solid #3f4147;border-radius:6px;overflow:auto;max-width:100%;white-space:pre;tab-size:2}
  .code-block code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:13px;color:#dbdee1}
  .spoiler{display:inline;border-radius:3px;padding:0 3px;background:#1e1f22;color:#1e1f22;cursor:help;transition:.12s}
  .spoiler:hover,.spoiler:focus{background:#46484f;color:#dbdee1}
  .md-link{color:#00a8fc;text-decoration:none;overflow-wrap:anywhere}.md-link:hover{text-decoration:underline}.masked-link{font-weight:500}
  .mention{display:inline-flex;align-items:center;max-width:100%;padding:0 3px;border-radius:3px;background:rgba(88,101,242,.28);color:#c9cdfb;font-weight:600;vertical-align:baseline;overflow-wrap:anywhere}
  .role-mention{background:rgba(88,101,242,.20)}.channel-mention{background:rgba(88,101,242,.18)}.everyone-mention{background:rgba(250,166,26,.20);color:#ffd69a}
  .discord-timestamp{display:inline-block;padding:0 3px;border-radius:3px;background:#2b2d31;color:#dbdee1}
  .custom-emoji{display:inline-block;width:1.45em;height:1.45em;object-fit:contain;vertical-align:-.34em;margin:0 .05em;max-width:none}
  .discord-embed{position:relative;display:flex;width:min(100%,760px);margin-top:9px;padding:12px 14px;border-left:4px solid var(--accent);border-radius:4px;background:#2b2d31;overflow:visible}
  .embed-main{min-width:0;max-width:100%;flex:1}.embed-author{font-size:13px;font-weight:600;color:#f2f3f5;margin-bottom:6px}
  .embed-title{font-weight:700;color:white;margin-bottom:5px;overflow-wrap:anywhere}.embed-description{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .embed-fields{display:grid;gap:8px;margin-top:8px}.embed-field{min-width:0}.embed-field-name{font-weight:700;color:white;overflow-wrap:anywhere}.embed-field-value{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
  .embed-thumb-link{display:block;flex:0 0 auto;margin-right:12px}.embed-thumb{display:block;width:80px;height:80px;object-fit:contain;border-radius:8px}
  .embed-image-link{display:block;width:100%;margin-top:10px}.embed-image{display:block;width:auto;height:auto;max-width:100%;max-height:none;border-radius:8px;object-fit:contain}
  .embed-footer{margin-top:10px;color:var(--muted);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
  .attachment{width:min(100%,900px);margin-top:10px;padding:10px;border:1px solid #404249;border-radius:10px;background:#232428;overflow:visible}
  .attachment a{color:#00a8fc;text-decoration:none;font-weight:600;overflow-wrap:anywhere}
  .attachment-image-link{display:block;width:100%;margin-top:8px}.attachment-image{display:block;width:auto;height:auto;max-width:100%;max-height:none;border-radius:8px;object-fit:contain}
  .stickers{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.sticker-link{display:block}.sticker-image{display:block;width:auto;height:auto;max-width:180px;max-height:180px;object-fit:contain}
  .sticker-name{color:var(--muted)}
  .reactions{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.reaction{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:3px 8px;border:1px solid #3f4147;border-radius:8px;background:#2b2d31}.reaction .custom-emoji{width:20px;height:20px;vertical-align:middle}.unicode-reaction{font-size:18px;line-height:20px}.reaction-count{font-size:13px;color:#b5bac1}
  .integrity-card{margin-top:20px;background:#17181c;border:1px solid var(--border);border-left:5px solid #23a55a;border-radius:16px;padding:20px}
  .integrity-card h2{margin:0 0 6px;color:#fff;font-size:21px}.integrity-subtitle{color:var(--muted);margin-bottom:15px}
  .integrity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
  .integrity-item{background:#111214;border:1px solid #313338;border-radius:10px;padding:12px;min-width:0}
  .integrity-item span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
  .integrity-item b,.integrity-item code{display:block;color:#f2f3f5;overflow-wrap:anywhere;word-break:break-all}
  .integrity-item code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:11px;background:transparent;padding:0}
  .integrity-valid{color:#57f287!important}.integrity-help{margin-top:13px;color:#b5bac1;font-size:13px;overflow-wrap:anywhere}
  .footer{text-align:center;color:var(--muted);font-size:12px;margin-top:18px}
  @media(max-width:640px){.shell{padding:16px 8px 40px}.message{padding:14px 10px;gap:10px}.avatar{width:36px;height:36px}.reply-preview{margin-left:-46px;padding-left:46px}.reply-connector{left:17px;width:24px}.reply-author{max-width:115px}.discord-embed{padding:10px}.embed-thumb{width:64px;height:64px}.attachment{padding:8px}}
</style>
</head>
<body>
<div class="shell">
  <section class="hero">
    <h1>🎫 Ticket #${escapeHtml(data.number)} Transcript</h1>
    <div class="subtitle">${escapeHtml(channel.guild.name)} • #${escapeHtml(channel.name)}</div>
    <div class="stats">
      <div class="stat"><b>${escapeHtml(type.label)}</b><span>Ticket type</span></div>
      <div class="stat"><b>${messages.length}</b><span>Messages</span></div>
      <div class="stat"><b>${participantIds.size}</b><span>Participants</span></div>
      <div class="stat"><b>${escapeHtml(generatedAt.toLocaleString('en-GB'))}</b><span>Generated</span></div>
    </div>
  </section>
  ${renderTranscriptAuditHtml(audit, data)}
  <section class="messages">${messageHtml || '<div class="message">No messages found.</div>'}</section>
  ${TRANSCRIPT_INTEGRITY_SLOT}
  <div class="footer">Generated by Snay Ticket Tool • Ticket creator ID: ${escapeHtml(data.creatorId)}</div>
</div>
</body>
</html>`;
}


function getTranscriptParticipants(messages) {
  const counts = new Map();

  for (const message of messages) {
    if (!message.author) continue;

    const existing = counts.get(message.author.id) || {
      id: message.author.id,
      count: 0,
      username: message.author.username || 'unknown',
      bot: Boolean(message.author.bot),
    };

    existing.count += 1;
    counts.set(message.author.id, existing);
  }

  return [...counts.values()].sort((a, b) => b.count - a.count);
}

async function buildTranscriptArtifact(
  channel,
  data,
  {
    transcriptCreatedByUser = null,
    closedById = null,
    closedAt = null,
  } = {},
) {
  const messages = await fetchAllChannelMessages(channel);
  const [
    audit,
    renderContext,
  ] = await Promise.all([
    buildTranscriptAuditData(
      channel,
      data,
      {
        transcriptCreatedByUser,
        closedById,
        closedAt,
      },
    ),
    buildTranscriptRenderContext(
      channel,
      messages,
    ),
  ]);

  const canonicalHtml = buildTranscriptHtml(
    channel,
    data,
    messages,
    audit,
    renderContext,
  );

  const safeType = TICKET_TYPES[data.typeKey]?.slug || 'ticket';
  const safeChannelName = String(channel.name || `ticket-${data.number}`)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 70);

  const signedTranscript = await signAndStoreTranscript({
    canonicalHtml,
    metadata: {
      guildId: channel.guild.id,
      guildName: channel.guild.name,
      channelId: channel.id,
      channelName: channel.name,
      ticketNumber: data.number,
      ticketType: data.typeKey,
      ticketTypeLabel:
        TICKET_TYPES[data.typeKey]?.label ||
        data.typeKey ||
        'Unknown',
      creatorId: data.creatorId,
      transcriptCreatedById:
        transcriptCreatedByUser?.id ||
        null,
      closedById:
        closedById ||
        data.closedById ||
        null,
      closedAt:
        closedAt ||
        data.closedAt ||
        null,
      deletionRequestedById: data.deletionRequestedById || null,
      deletionMethod: data.deletionMethod || null,
      messageCount: messages.length,
    },
  });

  return {
    messages,
    html: signedTranscript.html,
    filename:
      `transcript-${safeChannelName}-${signedTranscript.integrity.transcriptId}.html`,
    safeType,
    audit,
    integrity: signedTranscript.integrity,
  };
}

function transcriptArchiveError(code, message, details = {}) {
  const error = new Error(message);
  error.transcriptArchiveCode = code;
  error.transcriptArchiveDetails = details;
  return error;
}

function isDiscordUploadTooLarge(error) {
  const code = String(
    error?.code ||
    error?.rawError?.code ||
    '',
  );

  const message = String(
    error?.message ||
    error?.rawError?.message ||
    '',
  ).toLowerCase();

  return (
    code === '40005' ||
    message.includes('request entity too large') ||
    message.includes('file too large') ||
    message.includes('payload too large') ||
    message.includes('maximum file size')
  );
}

function isDiscordUploadTimeout(error) {
  const code =
    String(
      error?.code ||
      error?.cause?.code ||
      '',
    );

  const name =
    String(
      error?.name ||
      error?.cause?.name ||
      '',
    ).toLowerCase();

  const message =
    String(
      error?.message ||
      error?.cause?.message ||
      '',
    ).toLowerCase();

  return (
    code ===
      '20' ||
    code ===
      'ETIMEDOUT' ||
    code ===
      'UND_ERR_CONNECT_TIMEOUT' ||
    name ===
      'aborterror' ||
    message.includes(
      'operation was aborted',
    ) ||
    message.includes(
      'request aborted',
    ) ||
    message.includes(
      'timed out',
    ) ||
    message.includes(
      'timeout',
    )
  );
}

function isTransientDiscordUploadError(error) {
  const code =
    String(
      error?.code ||
      error?.cause?.code ||
      '',
    );

  const message =
    String(
      error?.message ||
      error?.cause?.message ||
      '',
    ).toLowerCase();

  return (
    isDiscordUploadTimeout(
      error,
    ) ||
    code ===
      'ECONNRESET' ||
    code ===
      'ECONNREFUSED' ||
    code ===
      'EAI_AGAIN' ||
    code ===
      'ENETUNREACH' ||
    code ===
      'UND_ERR_SOCKET' ||
    message.includes(
      'socket hang up',
    ) ||
    message.includes(
      'fetch failed',
    ) ||
    message.includes(
      'connection reset',
    )
  );
}

function makeTranscriptUploadNonce(transcriptId) {
  return createHash(
    'sha256',
  )
    .update(
      String(
        transcriptId ||
        'unknown-transcript',
      ),
    )
    .digest(
      'hex',
    )
    .slice(
      0,
      24,
    );
}

async function sendTranscriptArchiveAttempt({
  logChannel,
  buffer,
  filename,
  embed,
  nonce,
  attempts = 2,
  compressed = false,
}) {
  let lastError =
    null;

  for (
    let attempt =
      1;
    attempt <=
      attempts;
    attempt +=
      1
  ) {
    try {
      return await logChannel.send({
        files: [
          new AttachmentBuilder(
            buffer,
            {
              name:
                filename,
            },
          ),
        ],
        embeds: [
          embed,
        ],
        allowedMentions: {
          parse: [],
        },

        // Discord's nonce + enforceNonce support makes retries idempotent:
        // if the first upload actually reached Discord but our REST request
        // timed out locally, the retry returns the original message rather
        // than creating a duplicate archive.
        nonce,
        enforceNonce:
          true,
      });
    } catch (error) {
      lastError =
        error;

      if (
        !isTransientDiscordUploadError(
          error,
        ) ||
        attempt >=
          attempts
      ) {
        throw error;
      }

      console.warn(
        `[TICKET TRANSCRIPT UPLOAD RETRY] ${compressed ? 'gzip' : 'html'} ` +
          `attempt ${attempt}/${attempts} failed for ${filename}:`,
        error?.message ||
          error,
      );

      await delay(
        1250 *
          attempt,
      );
    }
  }

  throw lastError ||
    new Error(
      'Transcript upload failed without an error object.',
    );
}

function getTranscriptArchiveFailureMessage(error) {
  const code =
    error?.transcriptArchiveCode ||
    null;

  if (code === 'SIGNING_SECRET') {
    return (
      'The transcript signing system is not configured. ' +
      'Add **TRANSCRIPT_SIGNING_SECRET** in Render Environment (at least 32 characters), ' +
      'then redeploy the bot.'
    );
  }

  if (code === 'LOG_CHANNEL_MISSING') {
    return (
      `I cannot access the configured transcript log channel <#${TRANSCRIPT_LOG_CHANNEL_ID}>. ` +
      'Check that the channel still exists and the configured ID is correct.'
    );
  }

  if (code === 'LOG_PERMISSIONS') {
    const missing =
      error?.transcriptArchiveDetails?.missing ||
      [];

    return (
      `I am missing permissions in <#${TRANSCRIPT_LOG_CHANNEL_ID}>: ` +
      `**${missing.join(', ') || 'unknown permissions'}**.`
    );
  }

  if (code === 'MONGODB') {
    return (
      'The transcript was generated, but I could not save its integrity record to **MongoDB**. ' +
      'Check the MongoDB connection/configuration.'
    );
  }

  if (code === 'UPLOAD_TOO_LARGE') {
    return (
      'The generated transcript is too large for Discord to upload, even after compression. ' +
      'This usually happens when the ticket contains many large images.'
    );
  }

  if (code === 'UPLOAD_TIMEOUT') {
    return (
      'The transcript upload timed out after automatic retry and compressed fallback. ' +
      'The ticket was kept so no transcript data was lost. Please try Delete again in a moment.'
    );
  }

  if (code === 'DISCORD_UPLOAD') {
    const discordCode =
      error?.transcriptArchiveDetails?.discordCode;

    return (
      'Discord rejected the transcript upload' +
      (discordCode ? ` (error **${discordCode}**)` : '') +
      '. The ticket was kept so no transcript data was lost.'
    );
  }

  const message =
    String(error?.message || '');

  if (
    message.includes(
      'TRANSCRIPT_SIGNING_SECRET',
    )
  ) {
    return (
      'The transcript signing system is not configured. ' +
      'Add **TRANSCRIPT_SIGNING_SECRET** in Render Environment (at least 32 characters), ' +
      'then redeploy the bot.'
    );
  }

  return (
    'The transcript could not be archived because of an unexpected transcript-generation error. ' +
    'Check the Render logs for **[TICKET DELETE TRANSCRIPT LOG ERROR]**.'
  );
}

async function assertTranscriptLogReady(guild, logChannel) {
  if (
    !logChannel ||
    !logChannel.isTextBased() ||
    typeof logChannel.send !== 'function'
  ) {
    throw transcriptArchiveError(
      'LOG_CHANNEL_MISSING',
      `Transcript log channel ${TRANSCRIPT_LOG_CHANNEL_ID} is missing or not sendable.`,
    );
  }

  const me =
    guild.members.me ||
    (await guild.members
      .fetchMe()
      .catch(() => null));

  if (!me) {
    throw transcriptArchiveError(
      'LOG_PERMISSIONS',
      'Could not resolve the bot member to check transcript permissions.',
      {
        missing: ['Bot member unavailable'],
      },
    );
  }

  const permissions =
    logChannel.permissionsFor(me);

  const required = [
    [
      PermissionFlagsBits.ViewChannel,
      'View Channel',
    ],
    [
      PermissionFlagsBits.SendMessages,
      'Send Messages',
    ],
    [
      PermissionFlagsBits.AttachFiles,
      'Attach Files',
    ],
    [
      PermissionFlagsBits.EmbedLinks,
      'Embed Links',
    ],
  ];

  const missing =
    required
      .filter(
        ([permission]) =>
          !permissions?.has(permission),
      )
      .map(
        ([, label]) => label,
      );

  if (missing.length) {
    throw transcriptArchiveError(
      'LOG_PERMISSIONS',
      `Missing transcript log permissions: ${missing.join(', ')}`,
      {
        missing,
      },
    );
  }
}

async function sendTranscriptToLog(channel, data, deletedByUser) {
  const guild = channel.guild;
  const logChannel =
    guild.channels.cache.get(TRANSCRIPT_LOG_CHANNEL_ID) ||
    (await guild.channels
      .fetch(TRANSCRIPT_LOG_CHANNEL_ID)
      .catch(() => null));

  await assertTranscriptLogReady(
    guild,
    logChannel,
  );

  let artifact;

  try {
    await require('./report-staff-tracker').backfillTicketBeforeDelete(channel);
    artifact = await buildTranscriptArtifact(
      channel,
      data,
      {
        transcriptCreatedByUser: deletedByUser,
        closedById: data.closedById || null,
        closedAt: data.closedAt || null,
      },
    );
  } catch (error) {
    const message =
      String(error?.message || '');

    if (
      message.includes(
        'TRANSCRIPT_SIGNING_SECRET',
      )
    ) {
      throw transcriptArchiveError(
        'SIGNING_SECRET',
        message,
      );
    }

    if (
      message.toLowerCase().includes('mongo') ||
      message.toLowerCase().includes('database') ||
      error?.name === 'MongoServerError' ||
      error?.name === 'MongoNetworkError'
    ) {
      throw transcriptArchiveError(
        'MONGODB',
        message || 'MongoDB transcript integrity write failed.',
      );
    }

    throw error;
  }
  const creator =
    guild.members.cache.get(data.creatorId) ||
    (await guild.members.fetch(data.creatorId).catch(() => null));

  const creatorUser = creator?.user || null;
  const creatorName =
    creator?.displayName ||
    creatorUser?.globalName ||
    creatorUser?.username ||
    `User ${data.creatorId}`;
  const creatorAvatar = creatorUser?.displayAvatarURL({ size: 128 }) || null;

  const participants = getTranscriptParticipants(artifact.messages);
  let participantText = participants
    .slice(0, 12)
    .map(
      (participant) =>
        `${participant.count} - <@${participant.id}> - ${participant.username}${participant.bot ? ' [BOT]' : ''}`,
    )
    .join('\n');

  if (!participantText) participantText = 'No users found.';
  if (participants.length > 12) {
    participantText += `\n…and ${participants.length - 12} more.`;
  }
  if (participantText.length > 1024) {
    participantText = `${participantText.slice(0, 1000)}\n…`;
  }

  const type = TICKET_TYPES[data.typeKey] || { label: data.typeKey || 'Unknown' };

  const embed = new EmbedBuilder()
    .setColor(0x23d160)
    .setAuthor({
      name: creatorName,
      ...(creatorAvatar ? { iconURL: creatorAvatar } : {}),
    })
    .addFields(
      {
        name: 'Ticket Owner',
        value: `<@${data.creatorId}>`,
      },
      {
        name: 'First Claimed By',
        value:
          data.typeKey === 'report_staff'
            ? 'Not applicable'
            : artifact.audit.firstClaim
              ? `<@${artifact.audit.firstClaim.userId}>`
              : 'Unclaimed',
      },
      {
        name: 'Current / Final Claimer',
        value:
          data.typeKey === 'report_staff'
            ? 'Not applicable'
            : artifact.audit.currentClaimedById
              ? `<@${artifact.audit.currentClaimedById}>`
              : 'Unclaimed',
      },
      {
        name: 'Claim / Handover Events',
        value:
          data.typeKey === 'report_staff'
            ? 'Not applicable'
            : String(artifact.audit.claimHistory.length),
      },
      {
        name: 'Current Assistants',
        value:
          data.typeKey === 'report_staff'
            ? 'Not applicable'
            : artifact.audit.currentAssistants.length
              ? artifact.audit.currentAssistants
                  .map((id) => `<@${id}>`)
                  .join(', ')
                  .slice(0, 1024)
              : 'None',
      },
      {
        name: 'Handover Requests',
        value:
          data.typeKey === 'report_staff'
            ? 'Not applicable'
            : String(artifact.audit.handoverHistory.length),
        inline: true,
      },
      {
        name: 'Ticket Name',
        value: channel.name,
      },
      {
        name: 'Ticket Type',
        value: type.label,
        inline: true,
      },
      {
        name: 'Ticket Number',
        value: `#${data.number}`,
        inline: true,
      },
      {
        name: 'Panel Name',
        value: 'Support Tickets',
      },
      {
        name: 'Direct Transcript',
        value: 'Use Button',
      },
      {
        name: 'Users in transcript',
        value: participantText,
      },
      {
        name: data.deletionRequestedById ? 'Deletion Requested By' : 'Transcript Created By',
        value: `<@${data.deletionRequestedById || deletedByUser.id}>`,
      },
      {
        name: 'Ticket Closed By',
        value: data.closedById
          ? `<@${data.closedById}>`
          : 'Unknown',
      },
      {
        name: 'Ticket Closed At',
        value: data.closedAt
          ? `<t:${Math.floor(new Date(data.closedAt).getTime() / 1000)}:F>`
          : 'Time unavailable',
      },
      {
        name: 'Transcript ID',
        value: String(artifact.integrity.transcriptId),
      },
      {
        name: 'Integrity',
        value:
          '✅ **SHA-256 + HMAC-SHA256 signed**\n' +
          `SHA-256: ${artifact.integrity.sha256}`,
      },
    )
    .setFooter({
      text: `Pre-deletion safety archive • ${artifact.messages.length} messages`,
    })
    .setTimestamp();

  const htmlBuffer =
    Buffer.from(
      artifact.html,
      'utf8',
    );

  let logMessage;
  let uploadedFilename =
    artifact.filename;
  let compressed =
    false;

  const uploadNonce =
    makeTranscriptUploadNonce(
      artifact.integrity.transcriptId,
    );

  // Build the compressed fallback up front. Large self-contained transcripts
  // can contain embedded image data and may hit discord.js' REST timeout
  // before Discord returns a normal API response.
  const gzipBuffer =
    gzipSync(
      htmlBuffer,
      {
        level:
          9,
      },
    );

  const gzipFilename =
    `${artifact.filename}.gz`;

  // Prefer the compressed archive when the HTML is already several MiB or
  // compression meaningfully reduces the payload. This avoids waiting for a
  // large plain-HTML upload to time out before trying the smaller version.
  const preferCompressed =
    htmlBuffer.length >=
      4 *
        1024 *
        1024 ||
    gzipBuffer.length <=
      Math.floor(
        htmlBuffer.length *
          0.85,
      );

  const compressedEmbed =
    EmbedBuilder.from(
      embed,
    ).setFooter({
      text:
        `Pre-deletion safety archive • ${artifact.messages.length} messages • GZIP compressed`,
    });

  if (
    preferCompressed
  ) {
    try {
      logMessage =
        await sendTranscriptArchiveAttempt({
          logChannel,
          buffer:
            gzipBuffer,
          filename:
            gzipFilename,
          embed:
            compressedEmbed,
          nonce:
            uploadNonce,
          attempts:
            3,
          compressed:
            true,
        });

      uploadedFilename =
        gzipFilename;

      compressed =
        true;
    } catch (error) {
      if (
        isDiscordUploadTooLarge(
          error,
        )
      ) {
        throw transcriptArchiveError(
          'UPLOAD_TOO_LARGE',
          'Transcript remained too large after GZIP compression.',
          {
            htmlBytes:
              htmlBuffer.length,
            gzipBytes:
              gzipBuffer.length,
          },
        );
      }

      if (
        isDiscordUploadTimeout(
          error,
        )
      ) {
        throw transcriptArchiveError(
          'UPLOAD_TIMEOUT',
          'Transcript upload timed out after compressed retries.',
          {
            htmlBytes:
              htmlBuffer.length,
            gzipBytes:
              gzipBuffer.length,
            discordCode:
              error?.code ||
              error?.cause?.code ||
              null,
          },
        );
      }

      throw transcriptArchiveError(
        'DISCORD_UPLOAD',
        error?.message ||
          'Discord rejected the compressed transcript upload.',
        {
          discordCode:
            error?.code ||
            error?.rawError?.code ||
            error?.cause?.code ||
            null,
        },
      );
    }
  } else {
    try {
      logMessage =
        await sendTranscriptArchiveAttempt({
          logChannel,
          buffer:
            htmlBuffer,
          filename:
            artifact.filename,
          embed,
          nonce:
            uploadNonce,
          attempts:
            2,
          compressed:
            false,
        });
    } catch (error) {
      const shouldTryCompressed =
        isDiscordUploadTooLarge(
          error,
        ) ||
        isTransientDiscordUploadError(
          error,
        );

      if (
        !shouldTryCompressed
      ) {
        throw transcriptArchiveError(
          'DISCORD_UPLOAD',
          error?.message ||
            'Discord rejected the transcript upload.',
          {
            discordCode:
              error?.code ||
              error?.rawError?.code ||
              error?.cause?.code ||
              null,
          },
        );
      }

      console.warn(
        `[TICKET TRANSCRIPT COMPRESSED FALLBACK] Plain HTML upload failed for ` +
          `${artifact.filename}; retrying as GZIP.`,
        error?.message ||
          error,
      );

      try {
        logMessage =
          await sendTranscriptArchiveAttempt({
            logChannel,
            buffer:
              gzipBuffer,
            filename:
              gzipFilename,
            embed:
              compressedEmbed,
            nonce:
              uploadNonce,
            attempts:
              3,
            compressed:
              true,
          });

        uploadedFilename =
          gzipFilename;

        compressed =
          true;
      } catch (gzipError) {
        if (
          isDiscordUploadTooLarge(
            gzipError,
          )
        ) {
          throw transcriptArchiveError(
            'UPLOAD_TOO_LARGE',
            'Transcript remained too large after GZIP compression.',
            {
              htmlBytes:
                htmlBuffer.length,
              gzipBytes:
                gzipBuffer.length,
            },
          );
        }

        if (
          isDiscordUploadTimeout(
            gzipError,
          )
        ) {
          throw transcriptArchiveError(
            'UPLOAD_TIMEOUT',
            'Transcript upload timed out after plain and compressed retries.',
            {
              htmlBytes:
                htmlBuffer.length,
              gzipBytes:
                gzipBuffer.length,
              discordCode:
                gzipError?.code ||
                gzipError?.cause?.code ||
                null,
            },
          );
        }

        throw transcriptArchiveError(
          'DISCORD_UPLOAD',
          gzipError?.message ||
            'Discord rejected the compressed transcript upload.',
          {
            discordCode:
              gzipError?.code ||
              gzipError?.rawError?.code ||
              gzipError?.cause?.code ||
              null,
          },
        );
      }
    }
  }

  const uploadedTranscript =
    logMessage.attachments.first();

  if (uploadedTranscript?.url) {
    const directLinkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Direct Link')
        .setEmoji('📎')
        .setStyle(ButtonStyle.Link)
        .setURL(uploadedTranscript.url),
    );

    // The archive is already safely stored at this point. A transient failure
    // while adding the convenience Direct Link button must never make the bot
    // pretend the archive failed or keep the ticket unnecessarily.
    await logMessage
      .edit({
        components: [
          directLinkRow,
        ],
      })
      .catch(
        (error) => {
          console.warn(
            '[TICKET TRANSCRIPT DIRECT LINK EDIT WARNING]',
            error?.message ||
              error,
          );
        },
      );
  }

  console.log(
    `[TICKET TRANSCRIPT LOG] Ticket #${data.number} logged to ${TRANSCRIPT_LOG_CHANNEL_ID} ` +
      `with ${artifact.messages.length} messages.`,
  );

  return {
    logMessage,
    messageCount:
      artifact.messages.length,
    filename:
      uploadedFilename,
    compressed,
    integrity:
      artifact.integrity,
  };
}


async function sendReportStaffSecurityTranscript(
  channel,
  data,
  attemptedByUser,
  eventLabel = 'Blocked close attempt',
) {
  const guild = channel.guild;
  const logChannel =
    guild.channels.cache.get(REPORT_STAFF_SECURITY_LOG_CHANNEL_ID) ||
    (await guild.channels
      .fetch(REPORT_STAFF_SECURITY_LOG_CHANNEL_ID)
      .catch(() => null));

  if (
    !logChannel ||
    !logChannel.isTextBased() ||
    typeof logChannel.send !== 'function'
  ) {
    throw new Error(
      `Report Staff security log channel ${REPORT_STAFF_SECURITY_LOG_CHANNEL_ID} is missing or not sendable.`,
    );
  }

  const artifact = await buildTranscriptArtifact(
    channel,
    data,
    {
      transcriptCreatedByUser: attemptedByUser,
      closedById: null,
    },
  );

  const creator =
    guild.members.cache.get(data.creatorId) ||
    (await guild.members.fetch(data.creatorId).catch(() => null));
  const reported =
    (data.reportedStaffId &&
      (guild.members.cache.get(data.reportedStaffId) ||
        (await guild.members.fetch(data.reportedStaffId).catch(() => null)))) ||
    null;

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🛡️ Report Staff Security Transcript')
    .setDescription(
      `A protected action was blocked on a **Report Staff** ticket and a transcript was archived automatically.`,
    )
    .addFields(
      {
        name: 'Event',
        value: eventLabel,
      },
      {
        name: 'Ticket',
        value: `#${data.number} • ${channel.name}`,
      },
      {
        name: 'Ticket Owner',
        value: `<@${data.creatorId}>`,
        inline: true,
      },
      {
        name: 'Reported Staff',
        value: data.reportedStaffId
          ? `<@${data.reportedStaffId}>`
          : 'Not selected',
        inline: true,
      },
      {
        name: 'Attempted By',
        value: `<@${attemptedByUser.id}>`,
      },
      {
        name: 'Messages Captured',
        value: String(artifact.messages.length),
        inline: true,
      },
      {
        name: 'Transcript ID',
        value: String(artifact.integrity.transcriptId),
      },
      {
        name: 'Integrity',
        value: '✅ SHA-256 + HMAC-SHA256 signed',
      },
    )
    .setTimestamp();

  if (creator?.user?.displayAvatarURL) {
    embed.setAuthor({
      name:
        creator.displayName ||
        creator.user.globalName ||
        creator.user.username,
      iconURL: creator.user.displayAvatarURL({ size: 128 }),
    });
  }

  if (reported?.user) {
    embed.setFooter({
      text: `Reported staff: ${reported.user.username}`,
    });
  }

  const logMessage = await logChannel.send({
    files: [
      new AttachmentBuilder(Buffer.from(artifact.html, 'utf8'), {
        name: artifact.filename,
      }),
    ],
    embeds: [embed],
    allowedMentions: { parse: [] },
  });

  const uploadedTranscript = logMessage.attachments.first();

  if (uploadedTranscript?.url) {
    await logMessage.edit({
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Direct Link')
            .setEmoji('📎')
            .setStyle(ButtonStyle.Link)
            .setURL(uploadedTranscript.url),
        ),
      ],
    });
  }

  console.log(
    `[REPORT STAFF SECURITY] Transcript for ticket #${data.number} sent to ` +
      `${REPORT_STAFF_SECURITY_LOG_CHANNEL_ID} after ${eventLabel}.`,
  );

  return logMessage;
}

async function sendTranscript(interaction) {
  const baseData = getTicketData(interaction.channel);
  const data =
    (await getLiveTicketData(interaction.channel).catch(() => null)) ||
    baseData;

  if (!data) {
    console.warn(
      `[TICKET TRANSCRIPT STALE CONTROL] Ignored Transcript outside a ticket in ` +
        `${interaction.channelId || interaction.channel?.id || 'unknown'}.`,
    );

    await interaction
      .deferUpdate()
      .catch(
        () =>
          {},
      );

    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isStaffForTicket(interaction, member)) {
    await interaction.reply({
      content: 'Only a member of the **staff team** can download normal ticket transcripts. Staff ticket creators can use this on their own ticket too.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const artifact = await buildTranscriptArtifact(
      interaction.channel,
      data,
      {
        transcriptCreatedByUser: interaction.user,
        closedById:
          data.closedById ||
          getClosedByIdFromControlMessage(interaction.message),
        closedAt:
          data.closedAt ||
          getClosedAtFromControlMessage(interaction.message),
      },
    );

    await interaction.editReply({
      content:
        `📑 Transcript ready — **${artifact.messages.length} messages** captured.\n` +
        `🛡️ Transcript ID: ${artifact.integrity.transcriptId}`,
      files: [
        new AttachmentBuilder(Buffer.from(artifact.html, 'utf8'), {
          name: artifact.filename,
        }),
      ],
    });
  } catch (error) {
    console.error('[TICKET TRANSCRIPT ERROR]', error);
    await interaction.editReply(
      'I could not generate the transcript. Make sure I have **Read Message History** and that **Message Content Intent** is enabled in the Discord Developer Portal.',
    );
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteTicket(interaction) {
  await interaction.deferUpdate();
  const baseData = getTicketData(interaction.channel);
  const data =
    (await getLiveTicketData(interaction.channel).catch(() => null)) ||
    baseData;

  if (!data || !messageHasButton(interaction.message, 'ticket_delete')) {
    await interaction.followUp({
      content: 'These closed-ticket controls are no longer active.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  if (
    data.typeKey === 'report_staff' &&
    data.reportedStaffId === interaction.user.id
  ) {
    await interaction.followUp({
      content: 'You cannot delete a **Report Staff** ticket that is reporting you.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let permitted = isBotDeveloper(interaction.user);
  if (!permitted) {
    try {
      permitted = await canMemberUseCommand(member, ticketDeletePermissionKey(data.typeKey));
    } catch (error) {
      console.error('[TICKET DELETE PERMISSION ERROR]', error);
      await interaction.followUp({
        content: 'I could not check ticket deletion permissions. Please try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
  if (!permitted) {
    await interaction.followUp({
      content: 'You do not have permission to delete this ticket. The bot developer can configure Delete button access in `/permissions`.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  // Capture the original closer before the closed-ticket control embed is
  // replaced by the deletion countdown.
  const closedById =
    data.closedById ||
    getClosedByIdFromControlMessage(interaction.message) ||
    null;

  const closedAt =
    data.closedAt ||
    getClosedAtFromControlMessage(interaction.message) ||
    null;

  const transcriptData = {
    ...data,
    closedById,
    closedAt,
    deletionRequestedById: interaction.user.id,
    deletionMethod: 'Delete button',
  };

  const countdownEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('⛔ Deleting ticket')
    .setDescription(`This ticket will be deleted in **${DELETE_COUNTDOWN_SECONDS}** seconds.`)
    .setFooter({ text: `Delete requested by ${interaction.user.username}` });

  await interaction.message.edit({
    embeds: [countdownEmbed],
    components: [],
  }).catch(() => {});

  for (let seconds = DELETE_COUNTDOWN_SECONDS - 1; seconds >= 1; seconds -= 1) {
    await delay(1000);
    countdownEmbed.setDescription(`This ticket will be deleted in **${seconds}** second${seconds === 1 ? '' : 's'}.`);
    await interaction.message.edit({ embeds: [countdownEmbed], components: [] }).catch(() => {});
  }

  await delay(1000);
  const channelId = interaction.channel.id;

  // Generate and archive a FINAL transcript before deleting the channel.
  // If this fails, do not destroy the ticket — losing the channel without its
  // transcript would defeat the purpose of the audit log.
  try {
    countdownEmbed
      .setTitle('📑 Archiving transcript')
      .setDescription('Creating the final transcript and sending it to the ticket logs…');

    await interaction.message.edit({
      embeds: [countdownEmbed],
      components: [],
    }).catch(() => {});

    await sendTranscriptToLog(
      interaction.channel,
      transcriptData,
      interaction.user,
    );
  } catch (error) {
    console.error('[TICKET DELETE TRANSCRIPT LOG ERROR]', error);

    const restoreMessage = buildClosedTicketMessage(interaction.user.id);
    const publicFailure =
      getTranscriptArchiveFailureMessage(
        error,
      );

    restoreMessage.embeds[0]
      .setColor(0xed4245)
      .setDescription(
        '❌ **Ticket deletion cancelled**\n' +
        'I could not save the final transcript.\n\n' +
        `**Reason:** ${publicFailure}`,
      );

    await interaction.message.edit(restoreMessage).catch(() => {});

    const failureMessage =
      getTranscriptArchiveFailureMessage(
        error,
      );

    await interaction.followUp({
      content:
        'I did **not** delete the ticket because the final transcript could not be archived.\n\n' +
        `**Reason:** ${failureMessage}`,
      flags:
        MessageFlags.Ephemeral,
      allowedMentions: {
        parse: [],
      },
    }).catch(() => {});

    return;
  }

  try {
    await deleteTicketChannel(interaction.channel, 'button', interaction.user);
    await deleteTicketState(channelId).catch((error) => {
      console.error('[TICKET STATE DELETE ERROR]', error);
    });
  } catch (error) {
    console.error('[TICKET DELETE ERROR]', error);
    await interaction.followUp({
      content:
        `The transcript was archived in <#${TRANSCRIPT_LOG_CHANNEL_ID}>, but I could not delete this ticket. ` +
        'Check my **Manage Channels** permission.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

async function claimTicket(interaction) {
  return runTicketClaimQueued(
    interaction.channelId,
    () =>
      claimTicketUnlocked(
        interaction,
      ),
  );
}

async function claimTicketUnlocked(
  interaction,
) {
  const data =
    await getLiveTicketData(
      interaction.channel,
    );

  if (!data) {
    console.warn(
      `[TICKET CLAIM STALE CONTROL] Ignored Claim outside a ticket in ` +
        `${interaction.channelId || interaction.channel?.id || 'unknown'}.`,
    );

    await interaction
      .deferUpdate()
      .catch(
        () =>
          {},
      );

    return;
  }

  if (
    data.typeKey ===
      'report_staff'
  ) {
    await interaction.reply({
      content:
        'Claiming is not used for Report Staff tickets.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.closedAt) {
    await interaction.reply({
      content:
        'This ticket is currently closed.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const member =
    interaction.member ||
    interaction.guild.members.cache.get(
      interaction.user.id,
    ) ||
    (await interaction.guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null));

  if (
    !isTicketStaffMember(
      member,
    )
  ) {
    await interaction.reply({
      content:
        'Only a member of the staff team can claim tickets.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const creatorWasStaff =
    await wasTicketCreatedByStaff(
      interaction.guild,
      data,
    );

  // A stale Claim button can remain visible if an older claim committed but a
  // later UI side-effect failed. Administrators/developer/server owner bypass
  // that stale-control rejection and are taken straight into Assist.
  if (data.claimedById) {
    const assistManager =
      await isTicketAssistManager(
        member,
      );

    const isCurrentClaimer =
      String(
        data.claimedById,
      ) ===
      String(
        interaction.user.id,
      );

    if (
      assistManager ||
      isCurrentClaimer
    ) {
      await interaction.deferReply({
        flags:
          MessageFlags.Ephemeral,
      });

      await refreshClickedTicketControlMessage(
        interaction,
        data,
      ).catch((error) => {
        console.error(
          '[TICKET ADMIN STALE CLAIM BUTTON REPAIR ERROR]',
          error,
        );
      });

      await refreshTicketControlMessage(
        interaction.channel,
        data,
      ).catch((error) => {
        console.error(
          '[TICKET ADMIN CONTROL REFRESH ERROR]',
          error,
        );
      });

      await setTicketStaffTyping(
        interaction.channel,
        interaction.user.id,
        true,
        `Administrator/developer/configured-role Assist bypass for ${interaction.user.tag}`,
      ).catch((error) => {
        console.error(
          '[TICKET ADMIN CLAIM BYPASS PERMISSION ERROR]',
          error,
        );
      });

      const payload =
        buildAssistActionMenu();

      delete payload.flags;

      await interaction.editReply(
        payload,
      );

      return;
    }

    await interaction.reply({
      content:
        `This ticket is already claimed by <@${data.claimedById}>. ` +
        'The current claimer, an Administrator, or the configured Assist bypass role can use **Assist → Handover** if ownership needs to change.',
      flags:
        MessageFlags.Ephemeral,
      allowedMentions: {
        parse: [],
      },
    });
    return;
  }

  await interaction.deferUpdate();

  const claimedAt =
    new Date();

  const claimHistory =
    Array.isArray(
      data.claimHistory,
    )
      ? [
          ...data.claimHistory,
        ]
      : [];

  claimHistory.push({
    userId:
      interaction.user.id,
    claimedAt:
      claimedAt.toISOString(),
    previousClaimedById:
      null,
    action:
      'claim',
  });

  let nextData;

  // -----------------------------------------------------------------------
  // CRITICAL COMMIT
  // Only failure to persist ownership means the claim itself failed.
  // -----------------------------------------------------------------------
  try {
    nextData =
      await updateTicketTopic(
        interaction.channel,
        data,
        {
          claimedById:
            interaction.user.id,
          claimHistory,
          pendingHandover:
            null,
          creatorWasStaff,
        },
        `Ticket claimed by ${interaction.user.tag}`,
      );
  } catch (error) {
    console.error(
      '[TICKET CLAIM STATE COMMIT ERROR]',
      error,
    );

    await interaction.followUp({
      content:
        'I could not save the ticket claim. Please try again.',
      flags:
        MessageFlags.Ephemeral,
    }).catch(() => {});

    return;
  }

  // From this point onward the claim IS successful. Every operation below is
  // independent so a Discord permission/UI/stat error cannot roll it back or
  // suppress the public success message.

  // 1) Change the exact button that was clicked immediately.
  await refreshClickedTicketControlMessage(
    interaction,
    nextData,
  ).catch((error) => {
    console.error(
      '[TICKET CLAIM CLICKED CONTROL REFRESH ERROR]',
      error,
    );
  });

  // 2) Repair/enable the claimer's speaking access.
  await setTicketStaffTyping(
    interaction.channel,
    interaction.user.id,
    true,
    `Ticket claimed by ${interaction.user.tag}`,
  ).catch((error) => {
    console.error(
      '[TICKET CLAIM PERMISSION ERROR]',
      error,
    );
  });

  // 3) Award the first eligible claim stat. This is deliberately non-critical.
  if (
    TICKET_TYPES[
      data.typeKey
    ]?.awardsClaimPoints !==
      false &&
    !creatorWasStaff &&
    String(
      interaction.user.id,
    ) !==
      String(
        data.creatorId,
      )
  ) {
    const counted =
      await recordTicketClaim({
        guildId:
          interaction.guild.id,
        staffId:
          interaction.user.id,
        ticketNumber:
          data.number,
        typeKey:
          data.typeKey,
        channelId:
          interaction.channel.id,
        claimedAt,
      }).catch((error) => {
        console.error(
          '[STAFF TRACKING CLAIM ERROR]',
          error,
        );
        return false;
      });

    if (counted) {
      evaluateStaffGoalsForMember(
        interaction.guild,
        interaction.user.id,
      ).catch((error) => {
        console.error(
          '[STAFF GOAL CLAIM EVALUATION ERROR]',
          error,
        );
      });
    }
  } else if (creatorWasStaff) {
    console.log(
      `[TICKET CLAIM] Claim points skipped because ticket #${data.number} was created by a staff member.`,
    );
  } else if (
    TICKET_TYPES[
      data.typeKey
    ]?.awardsClaimPoints ===
      false
  ) {
    console.log(
      `[TICKET CLAIM] Claim points skipped for test ticket #${data.number} (${data.typeKey}).`,
    );
  }

  // 4) Fallback repair of the stored/pinned control message. Do not block the
  // success notice on this.
  refreshTicketControlMessage(
    interaction.channel,
    nextData,
  ).catch((error) => {
    console.error(
      '[TICKET CLAIM CONTROL FALLBACK REFRESH ERROR]',
      error,
    );
  });

  // 5) Always send the public claim notice once ownership committed.
  await interaction.channel
    .send({
      content:
        `🎫 Ticket claimed by <@${interaction.user.id}>.`,
      allowedMentions: {
        users: [
          interaction.user.id,
        ],
      },
    })
    .catch((error) => {
      console.error(
        '[TICKET CLAIM NOTICE SEND ERROR]',
        error,
      );
    });

  console.log(
    `[TICKET CLAIM SUCCESS] Ticket #${data.number} claimed by ${interaction.user.id}; ` +
      'ownership committed and side-effects processed independently.',
  );
}


function buildAssistActionMenu() {
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        'ticket_assist_action',
      )
      .setPlaceholder(
        'Choose an Assist action',
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        {
          label:
            'Add Staff',
          value:
            'add_staff',
          description:
            'Add one or more staff members who can talk in this ticket.',
          emoji:
            '➕',
        },
        {
          label:
            'Handover',
          value:
            'handover',
          description:
            'Transfer ownership after the selected staff member accepts.',
          emoji:
            '🔄',
        },
      );

  return {
    content:
      '**Assist** — choose what you want to do.',
    components: [
      new ActionRowBuilder()
        .addComponents(
          menu,
        ),
    ],
    flags:
      MessageFlags.Ephemeral,
  };
}

async function respondAssistAccessDenied(
  interaction,
  payload,
) {
  const safePayload = {
    ...payload,
    flags:
      MessageFlags.Ephemeral,
  };

  if (
    interaction.deferred ||
    interaction.replied
  ) {
    const editPayload = {
      ...safePayload,
    };

    delete editPayload.flags;

    await interaction
      .editReply(
        editPayload,
      )
      .catch(() => {});

    return;
  }

  await interaction
    .reply(
      safePayload,
    )
    .catch(() => {});
}

async function assertCurrentTicketOwner(
  interaction,
) {
  const data =
    await getLiveTicketData(
      interaction.channel,
    );

  if (
    !data ||
    data.typeKey ===
      'report_staff'
  ) {
    await respondAssistAccessDenied(
      interaction,
      {
        content:
          'This Assist control is not available here.',
      },
    );

    return null;
  }

  if (data.closedAt) {
    await respondAssistAccessDenied(
      interaction,
      {
        content:
          'This ticket is currently closed.',
      },
    );

    return null;
  }

  const member =
    await interaction.guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null);

  const assistManager =
    await isTicketAssistManager(
      member,
    );

  if (
    !assistManager &&
    String(
      data.claimedById ||
      '',
    ) !==
      String(
        interaction.user.id,
      )
  ) {
    await respondAssistAccessDenied(
      interaction,
      {
        content:
          data.claimedById
            ? `Only the current claimer <@${data.claimedById}>, an Administrator, or the configured Assist bypass role can manage **Assist**.`
            : 'This ticket must be claimed before Assist can be used.',
        allowedMentions: {
          parse: [],
        },
      },
    );

    return null;
  }

  // Administrators and the configured bypass role can manage Assist, but a ticket still needs a real owner before
  // Add Staff / Handover has meaningful ownership context.
  if (
    assistManager &&
    !data.claimedById
  ) {
    await respondAssistAccessDenied(
      interaction,
      {
        content:
          'An Administrator or the configured Assist bypass role can manage **Assist** after the ticket has been claimed.',
      },
    );

    return null;
  }

  return data;
}

async function openAssistMenu(
  interaction,
) {
  // Acknowledge immediately. Permission reconciliation can involve many member
  // overwrites and must not happen before Discord's 3-second interaction limit.
  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  const data =
    await assertCurrentTicketOwner(
      interaction,
    );

  if (!data) {
    return;
  }

  const actingMember =
    await interaction.guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null);

  if (
    await isTicketAssistManager(
      actingMember,
    )
  ) {
    await setTicketStaffTyping(
      interaction.channel,
      interaction.user.id,
      true,
      `Administrator/developer/configured-role Assist access repair for ${interaction.user.tag}`,
    ).catch((error) => {
      console.error(
        '[TICKET ADMIN ASSIST ACCESS REPAIR ERROR]',
        error,
      );
    });
  }

  const payload =
    buildAssistActionMenu();

  delete payload.flags;

  await interaction.editReply(
    payload,
  );

  // Repair after the menu is already visible.
  applyTicketStaffTypingState(
    interaction.channel,
    data,
    `Assist menu permission sync by ${interaction.user.tag}`,
  ).catch((error) => {
    console.error(
      '[TICKET ASSIST MENU PERMISSION SYNC ERROR]',
      error,
    );
  });
}

async function getEligibleAssistStaff(
  guild,
  data,
  mode,
) {
  const all =
    await getTicketStaffMembers(
      guild,
      data.creatorId,
    );

  const assistants =
    new Set(
      Array.isArray(
        data.assistStaffIds,
      )
        ? data.assistStaffIds.map(
            String,
          )
        : [],
    );

  return all.filter(
    (member) => {
      if (
        String(member.id) ===
        String(
          data.claimedById ||
            '',
        )
      ) {
        return false;
      }

      if (
        mode ===
          'add_staff' &&
        assistants.has(
          String(member.id),
        )
      ) {
        return false;
      }

      return true;
    },
  );
}

function buildAssistStaffPicker(
  mode,
  staffMembers,
  requestedPage = 0,
) {
  const pageCount =
    Math.max(
      1,
      Math.ceil(
        staffMembers.length /
        ASSIST_STAFF_PAGE_SIZE,
      ),
    );

  const page =
    Math.min(
      Math.max(
        Number(
          requestedPage,
        ) || 0,
        0,
      ),
      pageCount - 1,
    );

  const pageMembers =
    staffMembers.slice(
      page *
        ASSIST_STAFF_PAGE_SIZE,
      page *
        ASSIST_STAFF_PAGE_SIZE +
        ASSIST_STAFF_PAGE_SIZE,
    );

  if (!pageMembers.length) {
    return {
      content:
        mode === 'add_staff'
          ? 'There are no additional staff members available to add.'
          : 'There are no staff members available for handover.',
      components: [],
    };
  }

  const isAdd =
    mode ===
    'add_staff';

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        `${
          isAdd
            ? 'ticket_assist_staff_select'
            : 'ticket_handover_staff_select'
        }:${page}`,
      )
      .setPlaceholder(
        isAdd
          ? 'Select staff to add'
          : 'Select staff for handover',
      )
      .setMinValues(1)
      .setMaxValues(
        isAdd
          ? pageMembers.length
          : 1,
      )
      .addOptions(
        pageMembers.map(
          (member) => ({
            label:
              (
                member.displayName ||
                member.user.username
              ).slice(
                0,
                100,
              ),
            description:
              `Staff level ${
                Math.max(
                  0,
                  getHighestStaffRoleIndex(
                    member,
                  ),
                ) + 1
              }`.slice(
                0,
                100,
              ),
            value:
              member.id,
          }),
        ),
      );

  const components = [
    new ActionRowBuilder()
      .addComponents(
        select,
      ),
  ];

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              `${
                isAdd
                  ? 'ticket_assist_staff_page'
                  : 'ticket_handover_staff_page'
              }:${Math.max(
                0,
                page - 1,
              )}`,
            )
            .setEmoji('⬅️')
            .setStyle(
              ButtonStyle.Secondary,
            )
            .setDisabled(
              page <= 0,
            ),
          new ButtonBuilder()
            .setCustomId(
              'ticket_assist_page_label',
            )
            .setLabel(
              `Page ${page + 1}/${pageCount}`,
            )
            .setStyle(
              ButtonStyle.Secondary,
            )
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(
              `${
                isAdd
                  ? 'ticket_assist_staff_page'
                  : 'ticket_handover_staff_page'
              }:${Math.min(
                pageCount - 1,
                page + 1,
              )}`,
            )
            .setEmoji('➡️')
            .setStyle(
              ButtonStyle.Secondary,
            )
            .setDisabled(
              page >=
                pageCount - 1,
            ),
        ),
    );
  }

  return {
    content:
      isAdd
        ? '**Add Staff** — select one or more staff members. They will be allowed to talk in this ticket.'
        : '**Handover** — select one staff member. They must accept before ownership changes.',
    components,
  };
}

async function handleAssistAction(
  interaction,
) {
  const data =
    await assertCurrentTicketOwner(
      interaction,
    );

  if (!data) {
    return;
  }

  const mode =
    interaction.values[0];

  if (
    mode !==
      'add_staff' &&
    mode !==
      'handover'
  ) {
    await interaction.reply({
      content:
        'That Assist action is no longer valid.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const staffMembers =
    await getEligibleAssistStaff(
      interaction.guild,
      data,
      mode,
    );

  await interaction.update(
    buildAssistStaffPicker(
      mode,
      staffMembers,
      0,
    ),
  );
}

async function changeAssistStaffPage(
  interaction,
  mode,
) {
  const data =
    await assertCurrentTicketOwner(
      interaction,
    );

  if (!data) {
    return;
  }

  const page =
    Number(
      interaction.customId.split(
        ':',
      )[1],
    ) || 0;

  const staffMembers =
    await getEligibleAssistStaff(
      interaction.guild,
      data,
      mode,
    );

  await interaction.update(
    buildAssistStaffPicker(
      mode,
      staffMembers,
      page,
    ),
  );
}

async function addAssistStaff(
  interaction,
) {
  const data =
    await assertCurrentTicketOwner(
      interaction,
    );

  if (!data) {
    return;
  }

  const selectedIds =
    [
      ...new Set(
        interaction.values.map(
          String,
        ),
      ),
    ];

  const eligible =
    await getEligibleAssistStaff(
      interaction.guild,
      data,
      'add_staff',
    );

  const eligibleIds =
    new Set(
      eligible.map(
        (member) =>
          String(
            member.id,
          ),
      ),
    );

  const validIds =
    selectedIds.filter(
      (id) =>
        eligibleIds.has(
          id,
        ),
    );

  if (!validIds.length) {
    await interaction.reply({
      content:
        'None of the selected members are currently eligible to assist.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const now =
    new Date().toISOString();

  const assistStaffIds =
    [
      ...new Set([
        ...(
          Array.isArray(
            data.assistStaffIds,
          )
            ? data.assistStaffIds.map(
                String,
              )
            : []
        ),
        ...validIds,
      ]),
    ];

  const assistHistory = [
    ...(
      Array.isArray(
        data.assistHistory,
      )
        ? data.assistHistory
        : []
    ),
    ...validIds.map(
      (staffId) => ({
        staffId,
        addedById:
          interaction.user.id,
        addedAt:
          now,
      }),
    ),
  ];

  let nextData;

  try {
    // Persist the assistant list first so both the permission sync and the
    // MessageCreate staff guard read the same updated ownership state.
    nextData =
      await updateTicketTopic(
        interaction.channel,
        data,
        {
          assistStaffIds,
          assistHistory,
        },
        `Ticket assistants added by ${interaction.user.tag}`,
      );

    cacheTicketAssistants(
      interaction.channel.id,
      validIds,
    );

    await Promise.all(
      validIds.map(
        (staffId) =>
          setTicketStaffTyping(
            interaction.channel,
            staffId,
            true,
            `Added as ticket assistant by ${interaction.user.tag}`,
          ),
      ),
    );

    await refreshTicketControlMessage(
      interaction.channel,
      nextData,
    );
  } catch (error) {
    console.error(
      '[TICKET ASSIST ADD ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        'I could not add the selected staff members.',
      components: [],
    });
    return;
  }

  await interaction.editReply({
    content:
      `✅ Added ${validIds
        .map(
          (id) =>
            `<@${id}>`,
        )
        .join(', ')} as ticket assistants. Their **View Channel** and **Send Messages** access has been enabled.`,
    components: [],
    allowedMentions: {
      users:
        validIds,
    },
  });

  await interaction.channel
    .send({
      content:
        `🤝 ${validIds
          .map(
            (id) =>
              `<@${id}>`,
          )
          .join(' ')} ${
            validIds.length === 1
              ? 'has'
              : 'have'
          } been added to assist <@${data.claimedById}> on this ticket.`,
      allowedMentions: {
        users: [
          ...new Set([
            ...validIds,
            data.claimedById,
          ]),
        ],
      },
    })
    .catch(() => {});
}

function newHandoverRequestId() {
  return (
    `${Date.now().toString(36)}-` +
    `${Math.random()
      .toString(36)
      .slice(
        2,
        8,
      )}`
  );
}

async function requestTicketHandover(
  interaction,
) {
  const data =
    await assertCurrentTicketOwner(
      interaction,
    );

  if (!data) {
    return;
  }

  const selectedId =
    String(
      interaction.values[0] ||
      '',
    );

  const eligible =
    await getEligibleAssistStaff(
      interaction.guild,
      data,
      'handover',
    );

  const selectedMember =
    eligible.find(
      (member) =>
        String(
          member.id,
        ) ===
        selectedId,
    );

  if (!selectedMember) {
    await interaction.reply({
      content:
        'That staff member is no longer eligible for handover.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const requestId =
    newHandoverRequestId();

  const requestedAt =
    new Date().toISOString();

  const handoverHistory = [
    ...(
      Array.isArray(
        data.handoverHistory,
      )
        ? data.handoverHistory
        : []
    ),
    {
      requestId,
      fromStaffId:
        data.claimedById,
      toStaffId:
        selectedId,
      requestedAt,
      acceptedAt:
        null,
      status:
        'pending',
    },
  ];

  const pendingHandover = {
    requestId,
    fromStaffId:
      data.claimedById,
    toStaffId:
      selectedId,
    requestedAt,
  };

  try {
    await updateTicketTopic(
      interaction.channel,
      data,
      {
        pendingHandover,
        handoverHistory,
      },
      `Handover requested by ${interaction.user.tag}`,
    );

    const embed =
      new EmbedBuilder()
        .setColor(
          0xfee75c,
        )
        .setTitle(
          '🔄 Ticket Handover Requested',
        )
        .setDescription(
          `<@${data.claimedById}> wants to hand this ticket over to <@${selectedId}>.\n\n` +
          `<@${selectedId}> press **Accept Handover** below to become the new ticket owner.`,
        )
        .setFooter({
          text:
            'The current claimer keeps access until the handover is accepted.',
        });

    await interaction.channel.send({
      content:
        `<@${selectedId}>`,
      embeds: [
        embed,
      ],
      components: [
        new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(
                `ticket_handover_accept:${requestId}`,
              )
              .setLabel(
                'Accept Handover',
              )
              .setEmoji('✅')
              .setStyle(
                ButtonStyle.Success,
              ),
          ),
      ],
      allowedMentions: {
        users: [
          selectedId,
        ],
      },
    });

    await interaction.editReply({
      content:
        `✅ Handover requested from <@${data.claimedById}> to <@${selectedId}>. ` +
        'Ownership will not change until they accept.',
      components: [],
      allowedMentions: {
        users: [
          selectedId,
        ],
      },
    });
  } catch (error) {
    console.error(
      '[TICKET HANDOVER REQUEST ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        'I could not create the handover request.',
      components: [],
    });
  }
}

async function acceptTicketHandover(
  interaction,
) {
  const data =
    await getLiveTicketData(
      interaction.channel,
    );

  if (
    !data ||
    data.typeKey ===
      'report_staff'
  ) {
    await interaction.reply({
      content:
        'This handover request is no longer valid.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.closedAt) {
    await interaction.reply({
      content:
        'This ticket is currently closed.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  const requestId =
    interaction.customId.split(
      ':',
    )[1];

  const pending =
    data.pendingHandover;

  if (
    !pending ||
    String(
      pending.requestId,
    ) !==
      String(
        requestId,
      ) ||
    String(
      pending.toStaffId,
    ) !==
      String(
        interaction.user.id,
      ) ||
    String(
      pending.fromStaffId,
    ) !==
      String(
        data.claimedById,
      )
  ) {
    await interaction.reply({
      content:
        'This handover request has expired or was replaced by a newer request.',
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
      .catch(() => null);

  if (
    !isTicketStaffMember(
      member,
    )
  ) {
    await interaction.reply({
      content:
        'You are no longer an eligible staff member for this handover.',
      flags:
        MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const acceptedAt =
    new Date().toISOString();

  const oldOwnerId =
    String(
      data.claimedById,
    );

  const newOwnerId =
    String(
      interaction.user.id,
    );

  const assistStaffIds =
    (
      Array.isArray(
        data.assistStaffIds,
      )
        ? data.assistStaffIds
        : []
    )
      .map(
        String,
      )
      .filter(
        (id) =>
          id !==
            oldOwnerId &&
          id !==
            newOwnerId,
      );

  const claimHistory = [
    ...(
      Array.isArray(
        data.claimHistory,
      )
        ? data.claimHistory
        : []
    ),
    {
      userId:
        newOwnerId,
      claimedAt:
        acceptedAt,
      previousClaimedById:
        oldOwnerId,
      action:
        'handover',
    },
  ];

  const handoverHistory =
    (
      Array.isArray(
        data.handoverHistory,
      )
        ? data.handoverHistory
        : []
    ).map(
      (entry) =>
        String(
          entry?.requestId ||
          '',
        ) ===
          String(
            requestId,
          )
          ? {
              ...entry,
              acceptedAt,
              status:
                'accepted',
            }
          : entry,
    );

  try {
    // Old owner must lose talking rights even if they were previously in the
    // assistant list. New owner receives explicit member SendMessages access.
    removeCachedTicketAssistant(
      interaction.channel.id,
      oldOwnerId,
    );

    await setTicketStaffTyping(
      interaction.channel,
      oldOwnerId,
      false,
      `Ticket handed over to ${interaction.user.tag}`,
    );

    await setTicketStaffTyping(
      interaction.channel,
      newOwnerId,
      true,
      `Accepted ticket handover from ${oldOwnerId}`,
    );

    const nextData =
      await updateTicketTopic(
        interaction.channel,
        data,
        {
          claimedById:
            newOwnerId,
          assistStaffIds,
          claimHistory,
          handoverHistory,
          pendingHandover:
            null,
        },
        `Ticket handover accepted by ${interaction.user.tag}`,
      );

    await refreshTicketControlMessage(
      interaction.channel,
      nextData,
    );
  } catch (error) {
    console.error(
      '[TICKET HANDOVER ACCEPT ERROR]',
      error,
    );

    await interaction.followUp({
      content:
        'I could not complete the handover. The original owner still owns the ticket.',
      flags:
        MessageFlags.Ephemeral,
    }).catch(() => {});

    return;
  }

  await interaction.editReply({
    content:
      `✅ Handover accepted by <@${newOwnerId}>.\n` +
      `<@${oldOwnerId}> is no longer allowed to talk as staff in this ticket.`,
    embeds:
      interaction.message.embeds,
    components: [],
    allowedMentions: {
      users: [
        oldOwnerId,
        newOwnerId,
      ],
    },
  });

  await interaction.channel
    .send({
      content:
        `🔄 Ticket ownership transferred from <@${oldOwnerId}> to <@${newOwnerId}>.`,
      allowedMentions: {
        users: [
          oldOwnerId,
          newOwnerId,
        ],
      },
    })
    .catch(() => {});
}


async function updateInGameIdControlState(
  channel,
  data,
  disabled = true,
) {
  const controlMessage =
    await findTicketControlMessage(
      channel,
      data,
    );

  if (!controlMessage) {
    console.warn(
      `[TICKET IN-GAME ID] Could not find control message in ${channel.id}.`,
    );

    return;
  }

  const targetCustomId =
    `ticket_ingame_id:${data.creatorId}`;

  const components =
    controlMessage.components.map(
      (row) => {
        const rowJson =
          row.toJSON();

        rowJson.components =
          rowJson.components.map(
            (component) => {
              if (
                component.custom_id ===
                targetCustomId
              ) {
                return {
                  ...component,
                  disabled:
                    Boolean(
                      disabled,
                    ),
                };
              }

              return component;
            },
          );

        return rowJson;
      },
    );

  await controlMessage.edit({
    components,
  });
}

function normalizeYouTubeChannelUrl(
  value,
) {
  let parsed;

  try {
    parsed =
      new URL(
        String(
          value ||
          '',
        ).trim(),
      );
  } catch {
    return null;
  }

  if (
    parsed.protocol !==
      'https:' &&
    parsed.protocol !==
      'http:'
  ) {
    return null;
  }

  const hostname =
    parsed.hostname
      .toLowerCase()
      .replace(
        /^www\./,
        '',
      );

  if (
    hostname !==
      'youtube.com' &&
    hostname !==
      'm.youtube.com' &&
    hostname !==
      'youtu.be'
  ) {
    return null;
  }

  return parsed.toString();
}

async function updateYouTubeControlState(
  channel,
  data,
  rangeLabel,
) {
  const controlMessage =
    await findTicketControlMessage(
      channel,
      data,
    );

  if (!controlMessage) {
    console.warn(
      `[TICKET YOUTUBE] Could not find control message in ${channel.id}.`,
    );

    return;
  }

  const targetCustomId =
    `ticket_youtube_range:${data.creatorId}`;

  const components =
    controlMessage.components.map(
      (row) => {
        const rowJson =
          row.toJSON();

        rowJson.components =
          rowJson.components.map(
            (component) => {
              if (
                component.custom_id ===
                targetCustomId
              ) {
                return {
                  ...component,
                  disabled: true,
                  placeholder:
                    `Submitted: ${rangeLabel}`
                      .slice(
                        0,
                        150,
                      ),
                };
              }

              return component;
            },
          );

        return rowJson;
      },
    );

  await controlMessage.edit({
    components,
  });
}

async function openYouTubeLinkModal(
  interaction,
) {
  try {
    const [
      ,
      creatorId,
    ] =
      interaction.customId.split(
        ':',
      );

    const rangeKey =
      String(
        interaction.values?.[0] ||
        '',
      );

    const range =
      YOUTUBE_RANGES[
        rangeKey
      ];

    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (
      !data ||
      data.typeKey !==
        'youtuber_submission' ||
      String(
        data.creatorId,
      ) !==
        String(
          creatorId,
        ) ||
      !range
    ) {
      await interaction.reply({
        content:
          'This subscriber selection is no longer valid for this ticket.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (
      String(
        interaction.user.id,
      ) !==
        String(
          creatorId,
        )
    ) {
      await interaction.reply({
        content:
          'Only the ticket creator can complete the YouTuber submission.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (data.closedAt) {
      await interaction.reply({
        content:
          'This ticket is currently closed.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (
      data.youtubeStatus ===
        'done'
    ) {
      await interaction.reply({
        content:
          '✅ Your YouTube channel details have already been submitted.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    const channelLinkInput =
      new TextInputBuilder()
        .setCustomId(
          'youtube_channel_link',
        )
        .setLabel(
          'YouTube channel link',
        )
        .setPlaceholder(
          'https://youtube.com/@yourchannel',
        )
        .setStyle(
          TextInputStyle.Short,
        )
        .setMinLength(10)
        .setMaxLength(500)
        .setRequired(true);

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket_youtube_link:${creatorId}:${rangeKey}`,
        )
        .setTitle(
          'YouTuber Submission',
        )
        .addComponents(
          new ActionRowBuilder()
            .addComponents(
              channelLinkInput,
            ),
        );

    await interaction.showModal(
      modal,
    );
  } catch (error) {
    console.error(
      '[TICKET YOUTUBE MODAL OPEN ERROR]',
      error,
    );

    if (
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content:
          '❌ I could not open the YouTube channel form. Please try again.',
        flags:
          MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
}

async function handleYouTubeLinkModal(
  interaction,
) {
  const [
    ,
    creatorId,
    rangeKey,
  ] =
    interaction.customId.split(
      ':',
    );

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    const range =
      YOUTUBE_RANGES[
        rangeKey
      ];

    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (
      !data ||
      data.typeKey !==
        'youtuber_submission' ||
      String(
        data.creatorId,
      ) !==
        String(
          creatorId,
        ) ||
      !range
    ) {
      await interaction.editReply({
        content:
          'This YouTube submission form is no longer valid for this ticket.',
      });

      return;
    }

    if (
      String(
        interaction.user.id,
      ) !==
        String(
          creatorId,
        )
    ) {
      await interaction.editReply({
        content:
          'Only the ticket creator can complete the YouTuber submission.',
      });

      return;
    }

    if (data.closedAt) {
      await interaction.editReply({
        content:
          'This ticket is currently closed.',
      });

      return;
    }

    if (
      data.youtubeStatus ===
        'done'
    ) {
      await interaction.editReply({
        content:
          '✅ Your YouTube channel details have already been submitted.',
      });

      return;
    }

    const submittedLink =
      interaction.fields
        .getTextInputValue(
          'youtube_channel_link',
        );

    const channelUrl =
      normalizeYouTubeChannelUrl(
        submittedLink,
      );

    if (!channelUrl) {
      await interaction.editReply({
        content:
          '❌ Enter a valid YouTube channel link using `youtube.com` or `youtu.be`.',
      });

      return;
    }

    const next =
      await updateTicketTopic(
        interaction.channel,
        data,
        {
          youtubeStatus:
            'done',
        },
        `YouTube details submitted by ${interaction.user.tag}`,
      );

    const creatorUnlocked =
      shouldCreatorBeUnlocked(
        next,
      );

    let permissionError =
      null;

    await setCreatorTyping(
      interaction.channel,
      creatorId,
      creatorUnlocked,
      `YouTube details submitted by ${interaction.user.tag}`,
    ).catch((error) => {
      permissionError =
        error;

      console.error(
        '[TICKET YOUTUBE CREATOR PERMISSION ERROR]',
        error,
      );
    });

    await updateYouTubeControlState(
      interaction.channel,
      next,
      range.label,
    ).catch((error) => {
      console.error(
        '[TICKET YOUTUBE MENU UPDATE ERROR]',
        error,
      );
    });

    const detailsEmbed =
      new EmbedBuilder()
        .setColor(
          0xff0000,
        )
        .setTitle(
          '📺 YouTuber Submission Details',
        )
        .addFields(
          {
            name:
              'Submitted by',
            value:
              `<@${creatorId}>`,
            inline:
              true,
          },
          {
            name:
              'Subscriber range',
            value:
              range.label,
            inline:
              true,
          },
          {
            name:
              'YouTube channel',
            value:
              channelUrl,
            inline:
              false,
          },
        );

    await interaction.channel
      .send({
        embeds: [
          detailsEmbed,
        ],
        allowedMentions: {
          users: [
            creatorId,
          ],
        },
      })
      .catch((error) => {
        console.error(
          '[TICKET YOUTUBE DETAILS NOTICE ERROR]',
          error,
        );
      });

    if (permissionError) {
      await interaction.editReply({
        content:
          '⚠️ Your YouTube details were saved, but I could not update your typing permission. Please ask staff to check the ticket permissions.',
      });

      return;
    }

    await interaction.editReply({
      content:
        creatorUnlocked
          ? '✅ YouTube details submitted. You can now type in this ticket.'
          : '✅ YouTube details submitted. Submit your In-game ID before typing is unlocked.',
    });
  } catch (error) {
    console.error(
      '[TICKET YOUTUBE SUBMIT ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        '❌ I could not save your YouTube details. Please try again.',
    }).catch(() => {});
  }
}

async function openInGameIdModal(
  interaction,
) {
  try {
    const [
      ,
      creatorId,
    ] =
      interaction.customId.split(
        ':',
      );

    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (
      !data ||
      String(
        data.creatorId,
      ) !==
        String(
          creatorId,
        ) ||
      !TICKET_TYPES[
        data.typeKey
      ]?.requiresInGameId
    ) {
      await interaction.reply({
        content:
          'This In-game ID button is no longer valid for this ticket.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (
      String(
        interaction.user.id,
      ) !==
      String(
        creatorId,
      )
    ) {
      await interaction.reply({
        content:
          'Only the ticket creator can submit the In-game ID for this ticket.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (
      data.closedAt
    ) {
      await interaction.reply({
        content:
          'This ticket is currently closed.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    if (
      data.inGameIdStatus ===
        'done'
    ) {
      await interaction.reply({
        content:
          '✅ Your In-game ID has already been submitted for this ticket.',
        flags:
          MessageFlags.Ephemeral,
      });

      return;
    }

    const input =
      new TextInputBuilder()
        .setCustomId(
          'ingame_id',
        )
        .setLabel(
          'In-game user ID',
        )
        .setPlaceholder(
          'Enter your in-game user ID',
        )
        .setStyle(
          TextInputStyle.Short,
        )
        .setMinLength(1)
        .setMaxLength(100)
        .setRequired(true);

    const modal =
      new ModalBuilder()
        .setCustomId(
          `ticket_ingame_id_modal:${creatorId}`,
        )
        .setTitle(
          'Submit In-game ID',
        )
        .addComponents(
          new ActionRowBuilder()
            .addComponents(
              input,
            ),
        );

    await interaction.showModal(
      modal,
    );
  } catch (error) {
    console.error(
      '[TICKET IN-GAME ID MODAL ERROR]',
      error,
    );

    if (
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content:
          '❌ I could not open the In-game ID form. Please try again.',
        flags:
          MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
}

async function handleInGameIdModal(
  interaction,
) {
  const [
    ,
    creatorId,
  ] =
    interaction.customId.split(
      ':',
    );

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (
      !data ||
      String(
        data.creatorId,
      ) !==
        String(
          creatorId,
        ) ||
      !TICKET_TYPES[
        data.typeKey
      ]?.requiresInGameId
    ) {
      await interaction.editReply({
        content:
          'This In-game ID form is no longer valid for this ticket.',
      });

      return;
    }

    if (
      String(
        interaction.user.id,
      ) !==
      String(
        creatorId,
      )
    ) {
      await interaction.editReply({
        content:
          'Only the ticket creator can submit the In-game ID for this ticket.',
      });

      return;
    }

    if (
      data.closedAt
    ) {
      await interaction.editReply({
        content:
          'This ticket is currently closed.',
      });

      return;
    }

    if (
      data.inGameIdStatus ===
        'done'
    ) {
      await interaction.editReply({
        content:
          '✅ Your In-game ID has already been submitted.',
      });

      return;
    }

    const inGameId =
      interaction.fields
        .getTextInputValue(
          'ingame_id',
        )
        .trim();

    if (!inGameId) {
      await interaction.editReply({
        content:
          'Please enter a valid In-game ID.',
      });

      return;
    }

    const next =
      await updateTicketTopic(
        interaction.channel,
        data,
        {
          inGameIdStatus:
            'done',
        },
        `In-game ID submitted by ${interaction.user.tag}`,
      );

    const creatorUnlocked =
      shouldCreatorBeUnlocked(
        next,
      );

    await setCreatorTyping(
      interaction.channel,
      creatorId,
      creatorUnlocked,
      `In-game ID submitted by ${interaction.user.tag}`,
    );

    await updateInGameIdControlState(
      interaction.channel,
      next,
      true,
    ).catch((error) => {
      console.error(
        '[TICKET IN-GAME ID BUTTON UPDATE ERROR]',
        error,
      );
    });

    await interaction.channel
      .send({
        content:
          `🆔 In-game ID submitted by <@${creatorId}>: \`${inGameId.replaceAll('`', 'ˋ')}\``,
        allowedMentions: {
          users: [
            creatorId,
          ],
        },
      })
      .catch((error) => {
        console.error(
          '[TICKET IN-GAME ID NOTICE ERROR]',
          error,
        );
      });

    await interaction.editReply({
      content:
        creatorUnlocked
          ? '✅ In-game ID submitted. You can now type in this ticket.'
          : (
              data.typeKey ===
                'youtuber_submission'
                ? '✅ In-game ID submitted. Complete the remaining YouTuber submission step before typing is unlocked.'
                : '✅ In-game ID submitted.'
            ),
    });
  } catch (error) {
    console.error(
      '[TICKET IN-GAME ID SUBMIT ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        '❌ I could not save your In-game ID. Please try again.',
    }).catch(() => {});
  }
}

function canActorManageMember(
  guild,
  actor,
  target,
) {
  if (
    !guild ||
    !actor ||
    !target ||
    actor.id ===
      target.id ||
    target.id ===
      guild.ownerId
  ) {
    return false;
  }

  if (
    !actor.permissions.has(
      PermissionFlagsBits.ManageRoles,
    )
  ) {
    return false;
  }

  if (
    actor.id ===
      guild.ownerId
  ) {
    return true;
  }

  return (
    actor.roles.highest
      .comparePositionTo(
        target.roles.highest,
      ) >
    0
  );
}

async function getRoleContext(
  interaction,
  creatorId,
) {
  const guild =
    interaction.guild;

  if (!guild) {
    return {
      guild:
        null,
      actor:
        null,
      creator:
        null,
      botMember:
        null,
    };
  }

  const actor =
    interaction.member ||
    guild.members.cache.get(
      interaction.user.id,
    ) ||
    (await guild.members
      .fetch(
        interaction.user.id,
      )
      .catch(() => null));

  const creator =
    guild.members.cache.get(
      String(
        creatorId,
      ),
    ) ||
    (await guild.members
      .fetch(
        String(
          creatorId,
        ),
      )
      .catch(() => null));

  const botMember =
    guild.members.me ||
    (await guild.members
      .fetchMe()
      .catch(() => null));

  return {
    guild,
    actor,
    creator,
    botMember,
  };
}

async function getAssignableTicketRoles(
  interaction,
  creatorId,
) {
  const {
    guild,
    actor,
    creator,
    botMember,
  } =
    await getRoleContext(
      interaction,
      creatorId,
    );

  if (
    !guild ||
    !actor ||
    !creator ||
    !botMember
  ) {
    return {
      guild,
      actor,
      creator,
      botMember,
      config:
        null,
      roles: [],
      error:
        'I could not load the ticket user or server role information.',
    };
  }

  if (
    !actor.permissions.has(
      PermissionFlagsBits.ManageRoles,
    )
  ) {
    return {
      guild,
      actor,
      creator,
      botMember,
      config:
        null,
      roles: [],
      error:
        'You need **Manage Roles** to use the Role button.',
    };
  }

  if (
    !botMember.permissions.has(
      PermissionFlagsBits.ManageRoles,
    )
  ) {
    return {
      guild,
      actor,
      creator,
      botMember,
      config:
        null,
      roles: [],
      error:
        'I need **Manage Roles** to assign roles from tickets.',
    };
  }

  if (
    !canActorManageMember(
      guild,
      actor,
      creator,
    )
  ) {
    return {
      guild,
      actor,
      creator,
      botMember,
      config:
        null,
      roles: [],
      error:
        'Your highest role must be above the ticket creator before you can manage their roles.',
    };
  }

  const config =
    await getGuildConfig(
      guild,
    );

  if (
    !config ||
    !Array.isArray(
      config.roleIds,
    ) ||
    !config.roleIds.length
  ) {
    return {
      guild,
      actor,
      creator,
      botMember,
      config,
      roles: [],
      error:
        'No ticket roles are configured. Run `/ticket-panel reconfigure:true` to choose them.',
    };
  }

  const roles =
    config.roleIds
      .map(
        (roleId) =>
          guild.roles.cache.get(
            String(
              roleId,
            ),
          ),
      )
      .filter(
        (role) =>
          Boolean(
            role &&
            role.id !==
              guild.roles.everyone.id &&
            !role.managed &&
            !creator.roles.cache.has(
              role.id,
            ) &&
            canActorGiveRole(
              guild,
              actor,
              role,
            ) &&
            canBotGiveRole(
              botMember,
              role,
            ),
          ),
      )
      .sort(
        (a, b) =>
          b.position -
          a.position,
      );

  return {
    guild,
    actor,
    creator,
    botMember,
    config,
    roles,
    error:
      null,
  };
}

async function showRoleMenu(
  interaction,
  creatorId,
  requestedPage = 0,
) {
  const context =
    await getAssignableTicketRoles(
      interaction,
      creatorId,
    );

  if (
    context.error
  ) {
    await interaction.editReply({
      content:
        context.error,
      components: [],
      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const {
    creator,
    roles,
  } =
    context;

  if (!roles.length) {
    await interaction.editReply({
      content:
        `There are no configured roles currently available to give to <@${creator.id}>.`,
      components: [],
      allowedMentions: {
        parse: [],
      },
    });

    return;
  }

  const pageCount =
    Math.max(
      1,
      Math.ceil(
        roles.length /
        ROLE_PAGE_SIZE,
      ),
    );

  const page =
    Math.min(
      Math.max(
        Number(
          requestedPage,
        ) || 0,
        0,
      ),
      pageCount -
        1,
    );

  const pageRoles =
    roles.slice(
      page *
        ROLE_PAGE_SIZE,
      page *
        ROLE_PAGE_SIZE +
        ROLE_PAGE_SIZE,
    );

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        `ticket_role_select:${creator.id}`,
      )
      .setPlaceholder(
        'Select a role to give',
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        pageRoles.map(
          (role) => ({
            label:
              role.name.slice(
                0,
                100,
              ),
            description:
              `Position ${role.position}`.slice(
                0,
                100,
              ),
            value:
              role.id,
          }),
        ),
      );

  const components = [
    new ActionRowBuilder()
      .addComponents(
        select,
      ),
  ];

  if (
    pageCount >
    1
  ) {
    const navigation =
      new ActionRowBuilder();

    navigation.addComponents(
      new ButtonBuilder()
        .setCustomId(
          `ticket_role_page:${creator.id}:${Math.max(
            page - 1,
            0,
          )}`,
        )
        .setLabel('Back')
        .setEmoji('⬅️')
        .setStyle(
          ButtonStyle.Secondary,
        )
        .setDisabled(
          page ===
            0,
        ),
      new ButtonBuilder()
        .setCustomId(
          `ticket_role_page:${creator.id}:${Math.min(
            page + 1,
            pageCount - 1,
          )}`,
        )
        .setLabel(
          `${page + 1}/${pageCount}`,
        )
        .setStyle(
          ButtonStyle.Secondary,
        )
        .setDisabled(
          true,
        ),
      new ButtonBuilder()
        .setCustomId(
          `ticket_role_page:${creator.id}:${Math.min(
            page + 1,
            pageCount - 1,
          )}`,
        )
        .setLabel('Next')
        .setEmoji('➡️')
        .setStyle(
          ButtonStyle.Secondary,
        )
        .setDisabled(
          page >=
            pageCount -
              1,
        ),
    );

    components.push(
      navigation,
    );
  }

  await interaction.editReply({
    content:
      `🏷️ **Give Role** — choose a configured role to give to <@${creator.id}>.`,
    components,
    allowedMentions: {
      parse: [],
    },
  });
}

async function openRoleMenu(
  interaction,
) {
  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  try {
    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (!data) {
      console.warn(
        `[TICKET ROLE STALE CONTROL] Ignored Role outside a ticket in ` +
          `${interaction.channelId || interaction.channel?.id || 'unknown'}.`,
      );

      await interaction
        .deleteReply()
        .catch(
          () =>
            {},
        );

      return;
    }

    await showRoleMenu(
      interaction,
      data.creatorId,
      0,
    );
  } catch (error) {
    console.error(
      '[TICKET ROLE MENU ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        '❌ I could not open the ticket role menu. Check the Render log for `[TICKET ROLE MENU ERROR]`.',
      components: [],
      allowedMentions: {
        parse: [],
      },
    }).catch(() => {});
  }
}

async function changeRolePage(
  interaction,
) {
  await interaction.deferUpdate();

  try {
    const [
      ,
      creatorId,
      pageString,
    ] =
      interaction.customId.split(
        ':',
      );

    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (
      !data ||
      String(
        data.creatorId,
      ) !==
        String(
          creatorId,
        )
    ) {
      await interaction.editReply({
        content:
          'This role menu is no longer valid for this ticket.',
        components: [],
      });

      return;
    }

    await showRoleMenu(
      interaction,
      creatorId,
      Number(
        pageString,
      ) || 0,
    );
  } catch (error) {
    console.error(
      '[TICKET ROLE PAGE ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        '❌ I could not change the role-menu page.',
      components: [],
    }).catch(() => {});
  }
}

async function giveSelectedRole(
  interaction,
) {
  await interaction.deferUpdate();

  try {
    const [
      ,
      creatorId,
    ] =
      interaction.customId.split(
        ':',
      );

    const roleId =
      String(
        interaction.values?.[0] ||
        '',
      );

    const data =
      await getLiveTicketData(
        interaction.channel,
      );

    if (
      !data ||
      String(
        data.creatorId,
      ) !==
        String(
          creatorId,
        )
    ) {
      await interaction.editReply({
        content:
          'This role menu is no longer valid for this ticket.',
        components: [],
      });

      return;
    }

    const {
      guild,
      actor,
      creator,
      botMember,
      config,
      roles,
      error,
    } =
      await getAssignableTicketRoles(
        interaction,
        creatorId,
      );

    if (error) {
      await interaction.editReply({
        content:
          error,
        components: [],
        allowedMentions: {
          parse: [],
        },
      });

      return;
    }

    const role =
      guild.roles.cache.get(
        roleId,
      );

    if (
      !role ||
      !config?.roleIds
        ?.map(String)
        .includes(
          roleId,
        )
    ) {
      await interaction.editReply({
        content:
          'That role is no longer in the configured ticket-role list.',
        components: [],
      });

      return;
    }

    const stillAssignable =
      roles.some(
        (candidate) =>
          candidate.id ===
          role.id,
      ) &&
      canActorManageMember(
        guild,
        actor,
        creator,
      ) &&
      canActorGiveRole(
        guild,
        actor,
        role,
      ) &&
      canBotGiveRole(
        botMember,
        role,
      );

    if (!stillAssignable) {
      await interaction.editReply({
        content:
          'That role can no longer be assigned by you or by the bot.',
        components: [],
      });

      return;
    }

    await creator.roles.add(
      role,
      `Ticket role given by ${interaction.user.tag}`,
    );

    await interaction.editReply({
      content:
        `✅ Gave **${role.name}** to <@${creator.id}>.`,
      components: [],
      allowedMentions: {
        parse: [],
      },
    });

    await interaction.channel
      .send({
        content:
          `<@${interaction.user.id}> gave **${role.name}** to <@${creator.id}>.`,
        allowedMentions: {
          parse: [],
        },
      })
      .catch((error) => {
        console.error(
          '[TICKET ROLE PUBLIC NOTICE ERROR]',
          error,
        );
      });
  } catch (error) {
    console.error(
      '[TICKET ROLE ERROR]',
      error,
    );

    await interaction.editReply({
      content:
        '❌ I could not give that role. Check the bot role hierarchy/permissions and the Render log.',
      components: [],
      allowedMentions: {
        parse: [],
      },
    }).catch(() => {});
  }
}


async function selectReportedStaff(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const data = await getLiveTicketData(interaction.channel);

  if (
    !data ||
    data.typeKey !== 'report_staff' ||
    data.creatorId !== creatorId
  ) {
    await interaction.reply({
      content: 'This staff-report selector is no longer valid.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== creatorId) {
    await interaction.reply({
      content: 'Only the ticket creator can choose the staff member being reported.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.staffSelectionStatus === 'done') {
    await interaction.reply({
      content: 'The staff member for this report has already been selected.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedValue = interaction.values[0];

  // Navigation is embedded inside the select menu itself.
  if (
    selectedValue.startsWith('__next__:') ||
    selectedValue.startsWith('__back__:')
  ) {
    const [, rawPage] = selectedValue.split(':');
    const staffMembers = await getReportableStaffMembers(
      interaction.guild,
      creatorId,
    );

    if (!staffMembers.length) {
      await interaction.reply({
        content: 'No eligible staff members could be loaded.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.update({
      components: [
        getTicketButtons('report_staff'),
        ...buildReportStaffSelector(
          creatorId,
          staffMembers,
          Number(rawPage) || 0,
        ),
      ],
    });
    return;
  }

  const selectedStaffId = selectedValue;
  const selectedStaff = await interaction.guild.members
    .fetch(selectedStaffId)
    .catch(() => null);

  if (
    !selectedStaff ||
    selectedStaff.user.bot ||
    !selectedStaff.permissions.has(PermissionFlagsBits.ViewAuditLog)
  ) {
    await interaction.reply({
      content:
        'That member is no longer eligible for the staff-report list. Please choose another staff member.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const next = await updateTicketTopic(
      interaction.channel,
      data,
      {
        staffSelectionStatus: 'done',
        reportedStaffId: selectedStaff.id,
      },
      `Reported staff selected by ${interaction.user.tag}`,
    );

    await setCreatorTyping(
      interaction.channel,
      creatorId,
      shouldCreatorBeUnlocked(next),
      `Staff report target selected by ${interaction.user.tag}`,
    );

    // Add the selected/reported staff member directly to this private ticket.
    // This works for both normal staff and administrators. Administrator users
    // already bypass channel overwrites, but the explicit overwrite keeps the
    // intended access clear and also handles non-admin staff.
    await interaction.channel.permissionOverwrites.edit(
      selectedStaff.id,
      {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        AttachFiles: true,
        EmbedLinks: true,
      },
      `Reported staff added by ${interaction.user.tag}`,
    );
  } catch (error) {
    console.error('[REPORT STAFF SELECTION ERROR]', error);
    await interaction.reply({
      content: 'I could not save your staff selection. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.update({
    components: [getTicketButtons('report_staff')],
  });

  const selectedName =
    selectedStaff.displayName || selectedStaff.user.username;

  const evidenceEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🛠️ Staff report details required')
    .setDescription(
      `You selected **${selectedName}**.\n\n` +
        'You can now type in this ticket. Please explain exactly what happened and provide evidence to support the report. ' +
        'Useful evidence can include screenshots, video, message links, dates/times, and any other relevant context.\n\n' +
        '**The selected staff member has now been added to this ticket. Only server administrators may close this report.**',
    );

  await interaction.channel.send({
    content: `<@${creatorId}> <@${selectedStaff.id}>`,
    embeds: [evidenceEmbed],
    allowedMentions: {
      users: [...new Set([creatorId, selectedStaff.id])],
    },
  });
}


async function selectMutedSuspectedStaff(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const data = await getLiveTicketData(interaction.channel);

  if (
    !data ||
    data.typeKey !== 'muted_without_reason' ||
    data.creatorId !== creatorId
  ) {
    await interaction.reply({
      content: 'This mute-appeal staff selector is no longer valid.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== creatorId) {
    await interaction.reply({
      content: 'Only the ticket creator can use the suspected-staff selector.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedValue = interaction.values[0];

  if (
    selectedValue.startsWith('__next__:') ||
    selectedValue.startsWith('__back__:')
  ) {
    const [, rawPage] = selectedValue.split(':');
    const staffMembers = await getReportableStaffMembers(
      interaction.guild,
      creatorId,
    );

    if (!staffMembers.length) {
      await interaction.reply({
        content: 'No eligible staff members could be loaded right now.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.update({
      components: [
        getTicketButtons(
          'muted_without_reason',
          data.unmuteDecision,
          data.claimedById,
        ),
        buildInGameIdActionRow(
          creatorId,
          data.inGameIdStatus === 'done',
        ),
        ...buildMutedStaffSelector(
          creatorId,
          staffMembers,
          Number(rawPage) || 0,
        ),
        getTicketRenameButtonRow(),
      ],
    });
    return;
  }

  if (selectedValue === '__skip__') {
    try {
      await updateTicketTopic(
        interaction.channel,
        data,
        {
          staffSelectionStatus: 'skipped',
          reportedStaffId: null,
        },
        `Optional suspected muting staff skipped by ${interaction.user.tag}`,
      );

      await interaction.update({
        components: [
          getTicketButtons(
            'muted_without_reason',
            data.unmuteDecision,
            data.claimedById,
          ),
          buildInGameIdActionRow(
            creatorId,
            data.inGameIdStatus === 'done',
          ),
          getTicketRenameButtonRow(),
        ],
      });

      await interaction.followUp({
        content: '✅ Staff selection skipped. You can continue with your mute appeal.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error('[MUTE APPEAL STAFF SKIP ERROR]', error);
      await interaction.reply({
        content: 'I could not save that selection. Please try again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    return;
  }

  const selectedStaff = await interaction.guild.members
    .fetch(selectedValue)
    .catch(() => null);

  if (
    !selectedStaff ||
    selectedStaff.user.bot ||
    !selectedStaff.permissions.has(PermissionFlagsBits.ViewAuditLog)
  ) {
    await interaction.reply({
      content:
        'That member is no longer in the eligible staff list. Please select another person.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await updateTicketTopic(
      interaction.channel,
      data,
      {
        staffSelectionStatus: 'done',
        reportedStaffId: selectedStaff.id,
      },
      `Suspected muting staff selected by ${interaction.user.tag}`,
    );

    // Do NOT add or ping the suspected staff member. This is only an optional
    // piece of information for the support team reviewing the appeal.
    await interaction.update({
      components: [
        getTicketButtons(
          'muted_without_reason',
          data.unmuteDecision,
          data.claimedById,
        ),
        buildInGameIdActionRow(
          creatorId,
          data.inGameIdStatus === 'done',
        ),
        getTicketRenameButtonRow(),
      ],
    });

    await interaction.followUp({
      content:
        `✅ Saved **${selectedStaff.displayName || selectedStaff.user.username}** as the staff member you suspect muted you. ` +
        'They were **not** pinged or added to the ticket.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error('[MUTE APPEAL STAFF SELECTION ERROR]', error);
    await interaction.reply({
      content: 'I could not save that staff selection. Please try again.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

async function handleUnmuteDecision(interaction, decision) {
  const data = await getLiveTicketData(interaction.channel);

  if (!data || data.typeKey !== 'muted_without_reason') {
    await interaction.reply({
      content: 'This decision button only works inside a **Muted without reason?** ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  const canResolve = Boolean(
    member &&
      interaction.channel
        .permissionsFor(member)
        ?.has(PermissionFlagsBits.ManageMessages),
  );

  if (!canResolve) {
    await interaction.reply({
      content: 'You need **Manage Messages** to approve or reject an unmute appeal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.inGameIdStatus !== 'done') {
    await interaction.reply({
      content: 'The ticket creator must submit their **in-game user ID** before this appeal can be resolved.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.unmuteDecision) {
    await interaction.reply({
      content:
        `This appeal has already been **${data.unmuteDecision === 'approved' ? 'approved' : 'rejected'}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const approved = decision === 'approved';

  await interaction.deferUpdate();

  let nextData;
  try {
    nextData = await updateTicketTopic(
      interaction.channel,
      data,
      {
        unmuteDecision: approved ? 'approved' : 'rejected',
        unmuteDecisionBy: interaction.user.id,
      },
      `Unmute appeal ${approved ? 'approved' : 'rejected'} by ${interaction.user.tag}`,
    );
  } catch (error) {
    console.error('[UNMUTE DECISION STATE ERROR]', error);
    await interaction.followUp({
      content: 'I could not save the unmute decision. Please try again.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  // Keep the existing lower rows (In-game ID / any other components), but
  // replace the decision row so both resolution buttons become disabled.
  const remainingRows = interaction.message.components
    .slice(1)
    .map((row) => ActionRowBuilder.from(row));

  await interaction.message.edit({
    components: [
      getTicketButtons(
        'muted_without_reason',
        nextData.unmuteDecision,
        nextData.claimedById,
      ),
      ...remainingRows,
    ],
  }).catch((error) => {
    console.error('[UNMUTE DECISION BUTTON UPDATE ERROR]', error);
  });

  const resultEmbed = new EmbedBuilder()
    .setColor(approved ? 0x57f287 : 0xed4245)
    .setTitle(approved ? '✅ Approved Unmute' : '❌ Unmute Rejected')
    .setDescription(
      approved
        ? `<@${data.creatorId}> your account was mistakenly muted and the mute was not justified. We apologise.`
        : `<@${data.creatorId}> Unfortunately, your mute was justifiable and valid. You won't be unmuted at this time. Stick to the rules to avoid these outcomes!`,
    )
    .setFooter({
      text: `${approved ? 'Approved' : 'Rejected'} by ${interaction.user.username}`,
    })
    .setTimestamp();

  await interaction.channel.send({
    content: `<@${data.creatorId}>`,
    embeds: [resultEmbed],
    allowedMentions: { users: [data.creatorId] },
  });

  await interaction.followUp({
    content: `✅ Unmute appeal ${approved ? 'approved' : 'rejected'}.`,
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}


const departedTicketJobs = new Map();

async function creatorHasLeftGuild(guild, creatorId) {
  try {
    // Do not rely on cache: a member may have left while the bot was offline.
    await guild.members.fetch({ user: String(creatorId), force: true });
    return false;
  } catch (error) {
    if (Number(error?.code) === 10007) return true;
    // Missing permissions, network failures and rate limits are not proof of departure.
    throw error;
  }
}

async function closeDepartedCreatorTicket(channel, knownData = null) {
  if (departedTicketJobs.has(channel.id)) return departedTicketJobs.get(channel.id);
  const job = (async () => {
    const data = knownData || await getLiveTicketData(channel);
    if (!data?.creatorId || !await creatorHasLeftGuild(channel.guild, data.creatorId)) return false;
    const botUser = channel.client.user;
    const closedData = {
      ...data,
      closedById: data.closedById || botUser.id,
      closedAt: data.closedAt || new Date().toISOString(),
    };
    if (!data.closedAt) {
      if (channel.permissionOverwrites?.cache?.has(data.creatorId)) {
        await channel.permissionOverwrites.edit(data.creatorId, {
          ViewChannel: false, SendMessages: false,
        }, 'Ticket creator left the server');
      }
      await updateTicketTopic(channel, data, {
        closedById: closedData.closedById,
        closedAt: closedData.closedAt,
      }, 'Ticket creator left the server');
      await channel.send({
        content: '🔒 This ticket was automatically closed because its creator left the server.',
        ...buildClosedTicketMessage(botUser.id),
        allowedMentions: { parse: [] },
      });
      // Queue the cosmetic rename so rate limits cannot delay archiving.
      requestTicketChannelRename(
        channel,
        buildTicketChannelName(CLOSED_TICKET_NAME_PREFIX, data.number || 0,
          getTicketChannelLabel(channel, data) || TICKET_TYPES[data.typeKey]?.slug || 'ticket'),
        'Ticket creator left the server',
      );
    }
    const messages = await fetchAllChannelMessages(channel);
    const hasConversation = messages.some(message => !message.author?.bot && !message.system);
    // Empty tickets stay closed. A later human message triggers this check again.
    if (!hasConversation) return true;
    await sendTranscriptToLog(channel, closedData, botUser);
    // Recheck after archiving; a rejoin must not destroy a ticket unexpectedly.
    if (!await creatorHasLeftGuild(channel.guild, data.creatorId)) return true;
    await deleteTicketChannel(channel, 'automatic', botUser);
    liveTicketStateCache.delete(channel.id);
    ticketRenameStates.delete(channel.id);
    await deleteTicketState(channel.id);
    console.log(`[TICKET CREATOR DEPARTURE] Archived and deleted ${channel.id}; creator=${data.creatorId}.`);
    return true;
  })();
  departedTicketJobs.set(channel.id, job);
  try {
    return await job;
  } finally {
    departedTicketJobs.delete(channel.id);
  }
}

async function closeDepartedCreatorTickets(guild, creatorId = null) {
  const states = await getTicketStatesForGuild(guild.id);
  const stateById = new Map(states.map(state => [state.channelId, state]));
  await guild.channels.fetch();
  const channels = [...guild.channels.cache.values()].filter(channel => {
    const data = stateById.get(channel.id) || getTicketData(channel);
    return data?.creatorId && (!creatorId || String(data.creatorId) === String(creatorId));
  });
  for (const channel of channels) {
    try {
      await closeDepartedCreatorTicket(channel);
    } catch (error) {
      // Keep the channel if transcript archiving or membership verification fails.
      console.error(`[TICKET DEPARTURE CLEANUP ERROR] ${channel.id}`, error);
    }
  }
}


async function handleTicketMessageCreate(
  message,
) {
  if (
    !message?.guild ||
    !message.channel
  ) {
    return false;
  }

  if (
    message.type ===
      MessageType.ChannelPinnedMessage
  ) {
    const ticketData =
      await getLiveTicketData(
        message.channel,
      );

    if (ticketData) {
      await message
        .delete()
        .catch((error) => {
          console.error(
            '[TICKET LIVE PIN NOTICE DELETE ERROR]',
            error,
          );
        });

      return true;
    }
  }

  if (
    message.author?.bot ||
    message.system
  ) {
    return false;
  }

  const data =
    await getLiveTicketData(
      message.channel,
    );

  if (!data) return false;

  if (!message.guild.members.cache.has(String(data.creatorId))) {
    try {
      if (await closeDepartedCreatorTicket(message.channel, data)) return true;
    } catch (error) {
      console.error('[TICKET MESSAGE DEPARTURE CHECK ERROR]', error);
    }
  }

  if (data.typeKey === 'report_staff') return false;

  // The ticket creator is a customer in their own ticket even if they also
  // happen to hold a staff role.
  if (
    String(
      message.author.id,
    ) ===
    String(
      data.creatorId,
    )
  ) {
    return false;
  }

  const member =
    message.member ||
    (await message.guild.members
      .fetch(
        message.author.id,
      )
      .catch(() => null));

  if (
    !isTicketStaffMember(
      member,
    )
  ) {
    return false;
  }

  // Administrators always retain talking access in normal tickets. Never
  // delete their messages through the staff ownership guard.
  if (
    isTicketAdministrator(
      member,
    )
  ) {
    // Developer, server owner, and Discord Administrators are always allowed.
    // Repair a stale member-level deny on older active tickets as well.
    const overwrite =
      message.channel.permissionOverwrites.cache.get(
        member.id,
      );

    const explicitlyDenied =
      overwrite?.deny?.has(
        PermissionFlagsBits.SendMessages,
      );

    if (explicitlyDenied) {
      await setTicketStaffTyping(
        message.channel,
        member.id,
        true,
        `Administrator/developer ticket access repair for ${member.user.tag}`,
      ).catch((error) => {
        console.error(
          '[TICKET ADMIN ACCESS REPAIR ERROR]',
          error,
        );
      });
    }

    return false;
  }

  const assistants =
    new Set(
      Array.isArray(
        data.assistStaffIds,
      )
        ? data.assistStaffIds.map(
            String,
          )
        : [],
    );

  const authorId =
    String(
      message.author.id,
    );

  const memberOverwrite =
    message.channel.permissionOverwrites.cache.get(
      authorId,
    );

  const explicitlyAllowedToSend =
    Boolean(
      memberOverwrite?.allow?.has(
        PermissionFlagsBits.SendMessages,
      ) &&
      !memberOverwrite?.deny?.has(
        PermissionFlagsBits.SendMessages,
      ),
    );

  const assistantAuthorized =
    assistants.has(
      authorId,
    ) ||
    hasCachedTicketAssistant(
      message.channel.id,
      authorId,
    ) ||
    explicitlyAllowedToSend;

  const allowed =
    !data.closedAt &&
    (
      String(
        data.claimedById ||
        '',
      ) ===
        authorId ||
      assistantAuthorized
    );

  if (allowed) {
    const isCurrentOwner =
      String(
        data.claimedById ||
        '',
      ) ===
        authorId;

    if (
      assistantAuthorized &&
      !isCurrentOwner
    ) {
      cacheTicketAssistants(
        message.channel.id,
        [
          authorId,
        ],
      );
    }

    // If this member has a surviving Discord SendMessages allow from an older
    // ticket but their assistant ID was never persisted by the old
    // ticket-store.js, repair MongoDB in the background instead of deleting
    // their message after a future reboot.
    if (
      explicitlyAllowedToSend &&
      !isCurrentOwner &&
      !assistants.has(
        authorId,
      ) &&
      !isTicketAdministrator(
        member,
      )
    ) {
      const repairedAssistIds =
        [
          ...new Set([
            ...assistants,
            authorId,
          ]),
        ];

      cacheTicketAssistants(
        message.channel.id,
        [
          authorId,
        ],
      );

      updateTicketTopic(
        message.channel,
        data,
        {
          assistStaffIds:
            repairedAssistIds,
        },
        `Recovered legacy assistant access from Discord overwrite for ${message.author.tag}`,
      ).catch((error) => {
        console.error(
          '[TICKET LEGACY ASSISTANT PERSIST ERROR]',
          error,
        );
      });
    }

    // Saved owner/assistant state is authoritative. If an overwrite was lost
    // or manually changed while the bot was offline, repair it without holding
    // up or deleting the current message.
    if (
      isCurrentOwner ||
      assistants.has(
        authorId,
      )
    ) {
      ensureTicketSpeakerPermission(
        message.channel,
        authorId,
        `Self-healed saved ticket speaker access for ${message.author.tag}`,
      ).catch((error) => {
        console.error(
          '[TICKET SPEAKER SELF-HEAL ERROR]',
          error,
        );
      });
    }

    return false;
  }

  await message
    .delete()
    .catch((error) => {
      console.error(
        '[TICKET STAFF MESSAGE BLOCK ERROR]',
        error,
      );
    });

  console.log(
    `[TICKET STAFF LOCK] Removed unauthorized staff message from ` +
      `${message.author.tag} (${message.author.id}) in ${message.channel.id}.`,
  );

  // true tells index.js not to award a tracked-message point for something
  // that was not allowed to remain in the ticket.
  return true;
}

function isTicketChannelScopedInteraction(
  interaction,
) {
  const customId =
    String(
      interaction?.customId ||
      '',
    );

  if (
    !customId
  ) {
    return false;
  }

  if (
    interaction.isButton?.()
  ) {
    return (
      customId ===
        'ticket_close' ||
      customId ===
        'ticket_transcript' ||
      customId ===
        'ticket_reopen' ||
      customId ===
        'ticket_delete' ||
      customId ===
        'ticket_claim' ||
      customId ===
        'ticket_assist' ||
      customId ===
        'ticket_assist_page_label' ||
      customId ===
        'ticket_role' ||
      customId ===
        'ticket_rename' ||
      customId ===
        'ticket_unmute_approve' ||
      customId ===
        'ticket_unmute_reject' ||
      customId.startsWith(
        'ticket_assist_staff_page:',
      ) ||
      customId.startsWith(
        'ticket_handover_staff_page:',
      ) ||
      customId.startsWith(
        'ticket_handover_accept:',
      ) ||
      customId.startsWith(
        'ticket_role_page:',
      ) ||
      customId.startsWith(
        'ticket_ingame_id:',
      )
    );
  }

  if (
    interaction.isStringSelectMenu?.()
  ) {
    return (
      customId ===
        'ticket_assist_action' ||
      customId.startsWith(
        'ticket_assist_staff_select:',
      ) ||
      customId.startsWith(
        'ticket_handover_staff_select:',
      ) ||
      customId.startsWith(
        'ticket_role_select:',
      ) ||
      customId.startsWith(
        'ticket_report_staff_select:',
      ) ||
      customId.startsWith(
        'ticket_muted_staff_select:',
      ) ||
      customId.startsWith(
        'ticket_youtube_range:',
      )
    );
  }

  return false;
}

async function hasLiveTicketInteractionContext(
  interaction,
) {
  if (
    !interaction?.channel
  ) {
    return false;
  }

  const localData =
    getTicketData(
      interaction.channel,
    );

  if (
    localData
  ) {
    return true;
  }

  const liveData =
    await getLiveTicketData(
      interaction.channel,
    ).catch(
      () =>
        null,
    );

  return Boolean(
    liveData,
  );
}

async function ignoreStaleTicketControlOutsideTicket(
  interaction,
) {
  if (
    !isTicketChannelScopedInteraction(
      interaction,
    )
  ) {
    return false;
  }

  if (
    await hasLiveTicketInteractionContext(
      interaction,
    )
  ) {
    return false;
  }

  console.warn(
    `[TICKET STALE CONTROL IGNORED] ${interaction.customId} in non-ticket channel ` +
      `${interaction.channelId || interaction.channel?.id || 'unknown'} by ${interaction.user?.id || 'unknown'}.`,
  );

  if (
    interaction.isButton?.() ||
    interaction.isStringSelectMenu?.()
  ) {
    await interaction
      .deferUpdate()
      .catch(
        () =>
          {},
      );
  }

  return true;
}

async function handleTicketInteraction(interaction) {
  if (
    await ignoreStaleTicketControlOutsideTicket(
      interaction,
    )
  ) {
    return true;
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_create') {
      const member =
        interaction.member ||
        interaction.guild?.members.cache.get(
          interaction.user.id,
        ) ||
        null;

      await interaction.reply(
        buildTicketTypeMenu(
          member,
        ),
      );

      return true;
    }
    if (interaction.customId === 'ticket_close') return closeTicket(interaction);
    if (interaction.customId === 'ticket_transcript') return sendTranscript(interaction);
    if (interaction.customId === 'ticket_reopen') return reopenTicket(interaction);
    if (interaction.customId === 'ticket_delete') return deleteTicket(interaction);
    if (interaction.customId === 'ticket_claim') return claimTicket(interaction);
    if (interaction.customId === 'ticket_assist') return openAssistMenu(interaction);
    if (interaction.customId.startsWith('ticket_assist_staff_page:')) {
      return changeAssistStaffPage(interaction, 'add_staff');
    }
    if (interaction.customId.startsWith('ticket_handover_staff_page:')) {
      return changeAssistStaffPage(interaction, 'handover');
    }
    if (interaction.customId === 'ticket_assist_page_label') {
      await interaction.deferUpdate().catch(() => {});
      return true;
    }
    if (interaction.customId.startsWith('ticket_handover_accept:')) {
      return acceptTicketHandover(interaction);
    }
    if (interaction.customId === 'ticket_role') return openRoleMenu(interaction);
    if (interaction.customId === 'ticket_rename') return openTicketRenameModal(interaction);
    if (interaction.customId === 'ticket_unmute_approve') {
      return handleUnmuteDecision(interaction, 'approved');
    }
    if (interaction.customId === 'ticket_unmute_reject') {
      return handleUnmuteDecision(interaction, 'rejected');
    }
    if (interaction.customId.startsWith('ticket_role_page:')) return changeRolePage(interaction);
    if (interaction.customId.startsWith('ticket_ingame_id:')) return openInGameIdModal(interaction);
  }

  if (
    interaction.isChannelSelectMenu() &&
    interaction.customId.startsWith('ticket_setup_category:')
  ) {
    return handleSetupCategory(interaction);
  }

  if (
    interaction.isRoleSelectMenu() &&
    interaction.customId.startsWith('ticket_setup_roles:')
  ) {
    return handleSetupRoles(interaction);
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'ticket_create_type') {
      return createTicket(interaction, interaction.values[0]);
    }
    if (interaction.customId === 'ticket_assist_action') {
      return handleAssistAction(interaction);
    }
    if (interaction.customId.startsWith('ticket_assist_staff_select:')) {
      return addAssistStaff(interaction);
    }
    if (interaction.customId.startsWith('ticket_handover_staff_select:')) {
      return requestTicketHandover(interaction);
    }
    if (interaction.customId.startsWith('ticket_role_select:')) {
      return giveSelectedRole(interaction);
    }
    if (interaction.customId.startsWith('ticket_report_staff_select:')) {
      return selectReportedStaff(interaction);
    }
    if (interaction.customId.startsWith('ticket_muted_staff_select:')) {
      return selectMutedSuspectedStaff(interaction);
    }
    if (interaction.customId.startsWith('ticket_youtube_range:')) {
      return openYouTubeLinkModal(interaction);
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('ticket_rename_modal:')) {
      return handleTicketRenameModal(interaction);
    }
    if (interaction.customId.startsWith('ticket_ingame_id_modal:')) {
      return handleInGameIdModal(interaction);
    }
    if (interaction.customId.startsWith('ticket_youtube_link:')) {
      return handleYouTubeLinkModal(interaction);
    }
  }

  return false;
}

module.exports = {
  closeDepartedCreatorTickets,
  buildPanelMessage,
  getGuildConfig,
  handleTicketInteraction,
  handleTicketMessageCreate,
  restoreTicketRuntimeState,
  sendTicketPanelCommand,
};

