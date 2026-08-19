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
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { CONFIG_PATH, getServerConfig, setServerConfig } = require('./config-store');
const { getTicketState, setTicketState, deleteTicketState } = require('./ticket-store');
const { getNextTicketNumber } = require('./ticket-counter-store');
const { recordTicketClaim } = require('./staff-tracking-store');
const { evaluateStaffGoalsForMember } = require('./staff-settings');

const TICKET_NAME_PREFIX = 'ticket-';
const CLOSED_TICKET_NAME_PREFIX = 'closed-';
const ROLE_PAGE_SIZE = 25;
const DELETE_COUNTDOWN_SECONDS = 5;
const REPORT_STAFF_CATEGORY_ID = '1194859845426364497';
const REPORT_STAFF_PAGE_SIZE = 23;
// 22 leaves room for Back + Next + Skip/Not sure inside Discord's 25-option limit.
const MUTED_STAFF_PAGE_SIZE = 22;
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

function getTicketButtons(typeKey = null, unmuteDecision = null) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
  );

  // Muted-without-reason tickets have their own resolution controls.
  if (typeKey === 'muted_without_reason') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_unmute_approve')
        .setLabel('Approved Unmute')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(unmuteDecision)),
      new ButtonBuilder()
        .setCustomId('ticket_unmute_reject')
        .setLabel('Reject Unmute')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(Boolean(unmuteDecision)),
    );

    return row;
  }

  // Staff reports are intentionally restricted to Close only. They do not
  // expose Claim/Role because only administrators should handle these tickets.
  if (typeKey === 'report_staff') return row;

  row.addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket_role')
      .setLabel('Role')
      .setEmoji('🏷️')
      .setStyle(ButtonStyle.Success),
  );

  return row;
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

function buildTicketTypeMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_create_type')
    .setPlaceholder('What do you need help with?')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.entries(TICKET_TYPES).map(([value, type]) => ({
        label: type.label,
        value,
        emoji: type.emoji,
      })),
    );

  return {
    content: '**Create a ticket**\nSelect the type of ticket you want to open.',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
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

function getBottomPositionForCategory(category) {
  const positions = [
    category.rawPosition,
    ...category.children.cache.map((channel) => channel.rawPosition),
  ];

  return Math.max(...positions) + 1;
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

  const components = [getTicketButtons(typeKey)];

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
    claimHistory: [],
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
  if (
    !channel.name.startsWith(TICKET_NAME_PREFIX) &&
    !channel.name.startsWith(CLOSED_TICKET_NAME_PREFIX)
  ) return null;

  const topic = channel.topic || '';
  const numberMatch = topic.match(/Ticket #(\d+)/i);
  const typeMatch = topic.match(/(?:^|\|)\s*Type=([a-z_]+)/i);
  const creatorMatch = topic.match(/Created by <@!?(\d+)>/i);
  const igMatch = topic.match(/(?:^|\|)\s*IG=(pending|done|na)/i);
  const ytMatch = topic.match(/(?:^|\|)\s*YT=(pending|done|na)/i);
  const claimedMatch = topic.match(/Ticket claimed by <@!?(\d+)>/i);

  if (!creatorMatch) return null;

  const typeKey = typeMatch?.[1] || 'bug_report';
  const fallbackState = initialSubmissionState(typeKey);

  return {
    number: numberMatch ? Number(numberMatch[1]) : null,
    typeKey,
    creatorId: creatorMatch[1],
    inGameIdStatus: igMatch?.[1]?.toLowerCase() || fallbackState.inGameIdStatus,
    youtubeStatus: ytMatch?.[1]?.toLowerCase() || fallbackState.youtubeStatus,
    staffSelectionStatus: fallbackState.staffSelectionStatus,
    reportedStaffId: fallbackState.reportedStaffId,
    unmuteDecision: fallbackState.unmuteDecision,
    unmuteDecisionBy: fallbackState.unmuteDecisionBy,
    claimedById: claimedMatch ? claimedMatch[1] : null,
    claimHistory: [],
  };
}

async function updateTicketTopic(channel, data, patch = {}, reason = 'Ticket data updated') {
  // Historical function name retained to minimise churn in the ticket workflow.
  // It now stores mutable ticket state in MongoDB instead of editing the
  // Discord channel topic.
  const next = { ...data, ...patch };

  await setTicketState(channel.id, {
    guildId: channel.guildId,
    number: next.number,
    typeKey: next.typeKey,
    creatorId: next.creatorId,
    claimedById: next.claimedById || null,
    claimHistory: Array.isArray(next.claimHistory)
      ? next.claimHistory
      : [],
    inGameIdStatus: next.inGameIdStatus,
    youtubeStatus: next.youtubeStatus,
    staffSelectionStatus: next.staffSelectionStatus,
    reportedStaffId: next.reportedStaffId || null,
    unmuteDecision: next.unmuteDecision || null,
    unmuteDecisionBy: next.unmuteDecisionBy || null,
    updatedAt: new Date().toISOString(),
    updateReason: reason,
  });

  return next;
}

async function getLiveTicketData(channel) {
  const base = getTicketData(channel);
  if (!base) return null;

  try {
    const stored = await getTicketState(channel.id);
    if (!stored) return base;

    return {
      ...base,
      claimedById: stored.claimedById ?? base.claimedById,
      claimHistory:
        Array.isArray(stored.claimHistory) && stored.claimHistory.length
          ? stored.claimHistory
          : base.claimHistory,
      inGameIdStatus: stored.inGameIdStatus || base.inGameIdStatus,
      youtubeStatus: stored.youtubeStatus || base.youtubeStatus,
      staffSelectionStatus:
        stored.staffSelectionStatus || base.staffSelectionStatus,
      reportedStaffId: stored.reportedStaffId || base.reportedStaffId,
      unmuteDecision: stored.unmuteDecision || base.unmuteDecision,
      unmuteDecisionBy: stored.unmuteDecisionBy || base.unmuteDecisionBy,
    };
  } catch (error) {
    console.error('[TICKET STATE READ ERROR]', error);
    return base;
  }
}

async function runTicketCreationQueued(guildId, task) {
  const previous = ticketCreationQueues.get(guildId) || Promise.resolve();
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => blocker);
  ticketCreationQueues.set(guildId, queued);

  await previous.catch(() => {});

  try {
    return await task();
  } finally {
    release();
    if (ticketCreationQueues.get(guildId) === queued) {
      ticketCreationQueues.delete(guildId);
    }
  }
}


function mergeOverwrite(map, id, type, allowBits = 0n, denyBits = 0n) {
  const existing = map.get(id) || { id, type, allow: 0n, deny: 0n };

  existing.allow = (existing.allow | allowBits) & ~denyBits;
  existing.deny = (existing.deny | denyBits) & ~allowBits;

  map.set(id, existing);
}

function buildTicketPermissionOverwrites(guild, category, creatorId, botId, creatorCanSend) {
  const overwriteMap = new Map();

  for (const overwrite of category.permissionOverwrites.cache.values()) {
    overwriteMap.set(overwrite.id, {
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
    });
  }

  mergeOverwrite(
    overwriteMap,
    guild.roles.everyone.id,
    0,
    0n,
    PermissionFlagsBits.ViewChannel,
  );

  const baseTicketMemberPermissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.AttachFiles |
    PermissionFlagsBits.EmbedLinks;

  const creatorAllow = creatorCanSend
    ? baseTicketMemberPermissions | PermissionFlagsBits.SendMessages
    : baseTicketMemberPermissions;
  const creatorDeny = creatorCanSend ? 0n : PermissionFlagsBits.SendMessages;

  mergeOverwrite(overwriteMap, creatorId, 1, creatorAllow, creatorDeny);

  const botPermissions =
    baseTicketMemberPermissions |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.ManageChannels |
    PermissionFlagsBits.ManageMessages |
    PermissionFlagsBits.PinMessages;
  mergeOverwrite(overwriteMap, botId, 1, botPermissions, 0n);

  const staffPermissions = baseTicketMemberPermissions | PermissionFlagsBits.SendMessages;
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.roles.everyone.id) continue;
    if (
      !role.permissions.has(PermissionFlagsBits.ManageMessages) &&
      !role.permissions.has(PermissionFlagsBits.ManageRoles) &&
      !role.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      continue;
    }

    mergeOverwrite(overwriteMap, role.id, 0, staffPermissions, 0n);
  }

  return [...overwriteMap.values()];
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
  await channel.permissionOverwrites.edit(
    creatorId,
    {
      ViewChannel: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true,
      SendMessages: enabled,
    },
    reason,
  );
}

async function createTicket(interaction, typeKey) {
  if (!TICKET_TYPES[typeKey]) {
    await interaction.reply({
      content: 'That ticket type is no longer available. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Tickets can only be created inside a server.', components: [] });
    return;
  }

  const isReportStaff = typeKey === 'report_staff';
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

  await runTicketCreationQueued(guild.id, async () => {
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
    const permissionOverwrites = isReportStaff
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

    try {
      await setTicketState(channel.id, {
        guildId: guild.id,
        number: ticketNumber,
        typeKey,
        creatorId: interaction.user.id,
        claimedById: null,
        claimHistory: [],
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
      await channel.send(
        buildTicketWelcome(ticketNumber, interaction.user, typeKey, {
          reportStaffMembers,
        }),
      );
    } catch (error) {
      console.error('[TICKET WELCOME ERROR]', error);
    }

    await interaction.editReply({
      content: `✅ Your **${TICKET_TYPES[typeKey].label}** ticket has been created: <#${channel.id}>`,
      components: [],
      allowedMentions: { parse: [] },
    });
  });
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
    await interaction.reply({
      content: 'This button can only be used inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
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
    const isCreator = data.creatorId === interaction.user.id;
    const isStaff =
      interaction.channel
        .permissionsFor(member)
        ?.has(PermissionFlagsBits.ManageMessages) || false;

    if (!isCreator && !isStaff) {
      await interaction.reply({
        content:
          'Only the ticket creator or staff with **Manage Messages** can close this ticket.',
        flags: MessageFlags.Ephemeral,
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

  if (isTicketClosedForCreator(interaction.channel, data.creatorId)) {
    await interaction.editReply('This ticket is already closed.');
    return;
  }

  const type = TICKET_TYPES[data.typeKey] || TICKET_TYPES.bug_report;
  const ticketNumber = data.number ?? 0;
  const closedName = `${CLOSED_TICKET_NAME_PREFIX}${ticketNumber}_${type.slug}`.slice(0, 100);

  try {
    // Closed means closed for the ticket creator: explicitly remove their
    // channel visibility and ability to send messages.
    //
    // Discord members with Administrator bypass channel overwrites, so server
    // admins will still be able to view/manage the closed ticket as expected.
    // Other support staff continue to see it through their staff-role
    // permission overwrite, unless that same staff member is the ticket
    // creator (their member-specific deny intentionally wins until reopened).
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

    // Send the controls BEFORE requesting the rename. This keeps close/reopen
    // instant even when Discord queues repeated channel-name changes.
    await interaction.channel.send(buildClosedTicketMessage(interaction.user.id));
    await interaction.editReply('✅ Ticket closed.');

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

function isStaffForTicket(interaction, member) {
  return Boolean(
    member &&
      interaction.channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageMessages),
  );
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
      content: 'You need **Manage Messages** to reopen tickets.',
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
  const openName = `${TICKET_NAME_PREFIX}${ticketNumber}_${type.slug}`.slice(0, 100);
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

function formatTranscriptContent(message) {
  let content = message.content || '';

  for (const user of message.mentions.users.values()) {
    const member = message.guild?.members.cache.get(user.id);
    const name = member?.displayName || user.globalName || user.username;
    content = content
      .replaceAll(`<@${user.id}>`, `@${name}`)
      .replaceAll(`<@!${user.id}>`, `@${name}`);
  }

  for (const role of message.mentions.roles.values()) {
    content = content.replaceAll(`<@&${role.id}>`, `@${role.name}`);
  }

  for (const channel of message.mentions.channels.values()) {
    content = content.replaceAll(`<#${channel.id}>`, `#${channel.name || channel.id}`);
  }

  return escapeHtml(content);
}

function renderTranscriptEmbeds(message) {
  if (!message.embeds?.length) return '';

  return message.embeds.map((embed) => {
    const title = embed.title ? `<div class="embed-title">${escapeHtml(embed.title)}</div>` : '';
    const description = embed.description
      ? `<div class="embed-description">${escapeHtml(embed.description)}</div>`
      : '';
    const fields = embed.fields?.length
      ? `<div class="embed-fields">${embed.fields.map((field) => `
          <div class="embed-field">
            <div class="embed-field-name">${escapeHtml(field.name)}</div>
            <div>${escapeHtml(field.value)}</div>
          </div>`).join('')}</div>`
      : '';
    const thumbnail = embed.thumbnail?.url
      ? `<img class="embed-thumb" src="${escapeHtml(embed.thumbnail.url)}" alt="">`
      : '';
    const image = embed.image?.url
      ? `<img class="embed-image" src="${escapeHtml(embed.image.url)}" alt="">`
      : '';

    return `<div class="discord-embed">${thumbnail}<div>${title}${description}${fields}${image}</div></div>`;
  }).join('');
}

function renderTranscriptAttachments(message) {
  if (!message.attachments?.size) return '';

  return [...message.attachments.values()].map((attachment) => {
    const name = escapeHtml(attachment.name || 'attachment');
    const url = escapeHtml(attachment.url);
    const isImage = attachment.contentType?.startsWith('image/');

    return `
      <div class="attachment">
        <a href="${url}" target="_blank" rel="noreferrer">${name}</a>
        ${isImage ? `<img src="${url}" alt="${name}" loading="lazy">` : ''}
      </div>`;
  }).join('');
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

function normalizedClaimHistory(data) {
  const history = Array.isArray(data?.claimHistory)
    ? data.claimHistory
        .map((entry) => ({
          userId: entry?.userId ? String(entry.userId) : null,
          claimedAt: entry?.claimedAt ? String(entry.claimedAt) : null,
          previousClaimedById: entry?.previousClaimedById
            ? String(entry.previousClaimedById)
            : null,
          action: entry?.action === 'takeover' ? 'takeover' : 'claim',
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
  } = {},
) {
  const claimHistory = normalizedClaimHistory(data);

  const ids = new Set(
    claimHistory
      .flatMap((entry) => [
        entry.userId,
        entry.previousClaimedById,
      ])
      .filter(Boolean),
  );

  if (data?.claimedById) ids.add(String(data.claimedById));
  if (closedById) ids.add(String(closedById));
  if (transcriptCreatedByUser?.id) {
    ids.add(String(transcriptCreatedByUser.id));
  }

  const labels = new Map();

  await Promise.all(
    [...ids].map(async (userId) => {
      labels.set(
        String(userId),
        await getTranscriptUserLabel(channel.guild, userId),
      );
    }),
  );

  const firstClaim = claimHistory[0] || null;
  const finalClaim = claimHistory[claimHistory.length - 1] || null;

  return {
    firstClaim,
    finalClaim,
    currentClaimedById: data?.claimedById || finalClaim?.userId || null,
    claimHistory,
    closedById: closedById || null,
    transcriptCreatedById: transcriptCreatedByUser?.id || null,
    labels,
  };
}

function renderTranscriptAuditHtml(audit, data) {
  const isClaimNotApplicable =
    data.typeKey === 'report_staff' ||
    data.typeKey === 'muted_without_reason';

  const label = (userId) =>
    userId
      ? audit.labels.get(String(userId)) || `User ${userId}`
      : 'Unclaimed';

  const firstClaimedBy = isClaimNotApplicable
    ? 'Not applicable'
    : audit.firstClaim
      ? label(audit.firstClaim.userId)
      : 'Unclaimed';

  const firstClaimedAt = isClaimNotApplicable
    ? 'Not applicable'
    : audit.firstClaim
      ? formatAuditDate(audit.firstClaim.claimedAt)
      : 'Not claimed';

  const currentClaimer = isClaimNotApplicable
    ? 'Not applicable'
    : audit.currentClaimedById
      ? label(audit.currentClaimedById)
      : 'Unclaimed';

  const transcriptCreatedBy = audit.transcriptCreatedById
    ? label(audit.transcriptCreatedById)
    : 'Unknown';

  const closedBy = audit.closedById
    ? label(audit.closedById)
    : 'Unknown';

  const historyHtml = isClaimNotApplicable
    ? '<div class="claim-empty">Claiming is not used for this ticket type.</div>'
    : audit.claimHistory.length
      ? audit.claimHistory
          .map((entry, index) => {
            const actionLabel =
              index === 0 || entry.action !== 'takeover'
                ? 'First claim'
                : 'Takeover';

            const previous =
              entry.previousClaimedById
                ? `<span class="claim-from">from ${escapeHtml(
                    label(entry.previousClaimedById),
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
          })
          .join('\n')
      : '<div class="claim-empty">This ticket was never claimed.</div>';

  return `
  <section class="audit-card">
    <h2>Ticket Audit</h2>
    <div class="audit-grid">
      <div class="audit-item"><span>Claimed By (First)</span><b>${escapeHtml(firstClaimedBy)}</b></div>
      <div class="audit-item"><span>Claimed At</span><b>${escapeHtml(firstClaimedAt)}</b></div>
      <div class="audit-item"><span>Current / Final Claimer</span><b>${escapeHtml(currentClaimer)}</b></div>
      <div class="audit-item"><span>Transcript Created By</span><b>${escapeHtml(transcriptCreatedBy)}</b></div>
      <div class="audit-item"><span>Ticket Closed By</span><b>${escapeHtml(closedBy)}</b></div>
      <div class="audit-item"><span>Total Claims / Takeovers</span><b>${isClaimNotApplicable ? 'N/A' : audit.claimHistory.length}</b></div>
    </div>

    <h3>Claim / Takeover History</h3>
    <div class="claim-history">
      ${historyHtml}
    </div>
  </section>`;
}

function buildTranscriptHtml(channel, data, messages, audit) {
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
      const avatar = author?.displayAvatarURL({ extension: 'png', size: 128 }) || '';
      const timestamp = new Date(message.createdTimestamp).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'medium',
      });
      const content = formatTranscriptContent(message);
      const edited = message.editedTimestamp ? '<span class="edited">(edited)</span>' : '';
      const botBadge = author?.bot ? '<span class="bot-badge">BOT</span>' : '';

      return `
        <article class="message">
          <img class="avatar" src="${escapeHtml(avatar)}" alt="">
          <div class="message-body">
            <div class="message-meta">
              <strong>${escapeHtml(displayName)}</strong>
              ${botBadge}
              <span class="username">@${escapeHtml(username)}</span>
              <time>${escapeHtml(timestamp)}</time>
              ${edited}
            </div>
            ${content ? `<div class="content">${content}</div>` : ''}
            ${renderTranscriptEmbeds(message)}
            ${renderTranscriptAttachments(message)}
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
  body{margin:0;background:linear-gradient(180deg,#0b0c0e,#16171a);color:var(--text);font:15px/1.45 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
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
  .message-meta{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
  .message-meta strong{color:#f2f3f5}.username,time,.edited{color:var(--muted);font-size:12px}
  .bot-badge{font-size:10px;font-weight:800;background:var(--accent);padding:1px 5px;border-radius:4px;color:white}
  .content{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:3px}
  .discord-embed{position:relative;display:flex;max-width:650px;margin-top:9px;padding:12px 14px;border-left:4px solid var(--accent);border-radius:4px;background:#2b2d31}
  .embed-title{font-weight:700;color:white;margin-bottom:5px}.embed-description{white-space:pre-wrap}
  .embed-fields{display:grid;gap:8px;margin-top:8px}.embed-field-name{font-weight:700;color:white}
  .embed-thumb{width:72px;height:72px;object-fit:cover;border-radius:8px;margin-right:12px}
  .embed-image{display:block;max-width:100%;max-height:380px;border-radius:8px;margin-top:10px}
  .attachment{max-width:680px;margin-top:10px;padding:10px;border:1px solid #404249;border-radius:10px;background:#232428}
  .attachment a{color:#00a8fc;text-decoration:none;font-weight:600}
  .attachment img{display:block;max-width:100%;max-height:480px;margin-top:8px;border-radius:8px}
  .footer{text-align:center;color:var(--muted);font-size:12px;margin-top:18px}
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
  } = {},
) {
  const messages = await fetchAllChannelMessages(channel);
  const audit = await buildTranscriptAuditData(
    channel,
    data,
    {
      transcriptCreatedByUser,
      closedById,
    },
  );
  const html = buildTranscriptHtml(channel, data, messages, audit);
  const safeType = TICKET_TYPES[data.typeKey]?.slug || 'ticket';
  const safeChannelName = String(channel.name || `ticket-${data.number}`)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 70);

  return {
    messages,
    html,
    filename: `transcript-${safeChannelName}.html`,
    safeType,
    audit,
  };
}

async function sendTranscriptToLog(channel, data, deletedByUser) {
  const guild = channel.guild;
  const logChannel =
    guild.channels.cache.get(TRANSCRIPT_LOG_CHANNEL_ID) ||
    (await guild.channels.fetch(TRANSCRIPT_LOG_CHANNEL_ID).catch(() => null));

  if (
    !logChannel ||
    !logChannel.isTextBased() ||
    typeof logChannel.send !== 'function'
  ) {
    throw new Error(
      `Transcript log channel ${TRANSCRIPT_LOG_CHANNEL_ID} is missing or not sendable.`,
    );
  }

  const artifact = await buildTranscriptArtifact(
    channel,
    data,
    {
      transcriptCreatedByUser: deletedByUser,
      closedById: data.closedById || null,
    },
  );
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
          data.typeKey === 'report_staff' ||
          data.typeKey === 'muted_without_reason'
            ? 'Not applicable'
            : artifact.audit.firstClaim
              ? `<@${artifact.audit.firstClaim.userId}>`
              : 'Unclaimed',
      },
      {
        name: 'Current / Final Claimer',
        value:
          data.typeKey === 'report_staff' ||
          data.typeKey === 'muted_without_reason'
            ? 'Not applicable'
            : artifact.audit.currentClaimedById
              ? `<@${artifact.audit.currentClaimedById}>`
              : 'Unclaimed',
      },
      {
        name: 'Claim / Takeover Count',
        value:
          data.typeKey === 'report_staff' ||
          data.typeKey === 'muted_without_reason'
            ? 'Not applicable'
            : String(artifact.audit.claimHistory.length),
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
        name: 'Transcript Created By',
        value: `<@${deletedByUser.id}>`,
      },
      {
        name: 'Ticket Closed By',
        value: data.closedById
          ? `<@${data.closedById}>`
          : 'Unknown',
      },
    )
    .setFooter({
      text: `Final transcript • ${artifact.messages.length} messages`,
    })
    .setTimestamp();

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
    const directLinkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Direct Link')
        .setEmoji('📎')
        .setStyle(ButtonStyle.Link)
        .setURL(uploadedTranscript.url),
    );

    await logMessage.edit({
      components: [directLinkRow],
    });
  }

  console.log(
    `[TICKET TRANSCRIPT LOG] Ticket #${data.number} logged to ${TRANSCRIPT_LOG_CHANNEL_ID} ` +
      `with ${artifact.messages.length} messages.`,
  );

  return {
    logMessage,
    messageCount: artifact.messages.length,
    filename: artifact.filename,
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
    await interaction.reply({
      content: 'This button can only be used inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!isStaffForTicket(interaction, member)) {
    await interaction.reply({
      content: 'You need **Manage Messages** to download ticket transcripts.',
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
        closedById: getClosedByIdFromControlMessage(interaction.message),
      },
    );

    await interaction.editReply({
      content: `📑 Transcript ready — **${artifact.messages.length} messages** captured.`,
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
  const baseData = getTicketData(interaction.channel);
  const data =
    (await getLiveTicketData(interaction.channel).catch(() => null)) ||
    baseData;

  if (!data || !messageHasButton(interaction.message, 'ticket_delete')) {
    await interaction.reply({
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
    await interaction.reply({
      content: 'You cannot delete a **Report Staff** ticket that is reporting you.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    data.typeKey === 'report_staff' &&
    !member?.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content: 'Only a server **Administrator** can delete a Report Staff ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    data.typeKey !== 'report_staff' &&
    !isStaffForTicket(interaction, member)
  ) {
    await interaction.reply({
      content: 'You need **Manage Messages** to delete tickets.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Capture the original closer before the closed-ticket control embed is
  // replaced by the deletion countdown.
  const closedById =
    getClosedByIdFromControlMessage(interaction.message) ||
    null;

  const transcriptData = {
    ...data,
    closedById,
  };

  await interaction.deferUpdate();

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
    restoreMessage.embeds[0]
      .setColor(0xed4245)
      .setDescription(
        '❌ **Ticket deletion cancelled**\nI could not save the final transcript to the transcript log channel.',
      );

    await interaction.message.edit(restoreMessage).catch(() => {});

    await interaction.followUp({
      content:
        `I did **not** delete the ticket because I could not archive the transcript in <#${TRANSCRIPT_LOG_CHANNEL_ID}>. ` +
        'Check that I can **View Channel**, **Send Messages**, **Attach Files**, and **Embed Links** there.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    }).catch(() => {});

    return;
  }

  try {
    await interaction.channel.delete(`Closed ticket deleted by ${interaction.user.tag}`);
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
  const data = await getLiveTicketData(interaction.channel);
  if (!data) {
    await interaction.reply({
      content: 'This button can only be used inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (
    !member ||
    !interaction.channel
      .permissionsFor(member)
      ?.has(PermissionFlagsBits.ManageMessages)
  ) {
    await interaction.reply({
      content: 'You need **Manage Messages** to claim tickets.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The current claimer cannot create duplicate consecutive claim entries.
  // A DIFFERENT staff member may press Claim at any time to take over.
  if (data.claimedById === interaction.user.id) {
    await interaction.reply({
      content: 'You are already the current claimer for this ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const claimedAt = new Date();
  const previousClaimedById = data.claimedById || null;
  const action = previousClaimedById ? 'takeover' : 'claim';

  const existingHistory = Array.isArray(data.claimHistory)
    ? data.claimHistory
    : [];

  // Backward compatibility for tickets that were already claimed before this
  // update. We preserve the legacy claimer as the first history entry, although
  // its original timestamp cannot be recovered.
  const claimHistory = [...existingHistory];

  if (
    !claimHistory.length &&
    previousClaimedById &&
    previousClaimedById !== interaction.user.id
  ) {
    claimHistory.push({
      userId: previousClaimedById,
      claimedAt: null,
      previousClaimedById: null,
      action: 'claim',
    });
  }

  claimHistory.push({
    userId: interaction.user.id,
    claimedAt: claimedAt.toISOString(),
    previousClaimedById,
    action,
  });

  try {
    await updateTicketTopic(
      interaction.channel,
      data,
      {
        claimedById: interaction.user.id,
        claimHistory,
      },
      previousClaimedById
        ? `Ticket taken over by ${interaction.user.tag}`
        : `Ticket claimed by ${interaction.user.tag}`,
    );

    // Existing staff-performance tracking remains idempotent per ticket.
    // This means takeover history can contain multiple staff members without
    // allowing repeated handovers to inflate the same ticket's claim stat.
    await recordTicketClaim({
      guildId: interaction.guild.id,
      staffId: interaction.user.id,
      ticketNumber: data.number,
      typeKey: data.typeKey,
      channelId: interaction.channel.id,
      claimedAt,
    }).catch((statsError) => {
      console.error('[STAFF TRACKING CLAIM ERROR]', statsError);
    });

    await evaluateStaffGoalsForMember(
      interaction.guild,
      interaction.user.id,
    ).catch((goalError) => {
      console.error('[STAFF GOAL CLAIM EVALUATION ERROR]', goalError);
    });
  } catch (error) {
    console.error('[TICKET CLAIM STATE ERROR]', error);
    await interaction.reply({
      content: 'I could not save the claim/takeover state. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (previousClaimedById) {
    await interaction.reply({
      content:
        `🔄 Ticket taken over by <@${interaction.user.id}> ` +
        `from <@${previousClaimedById}>.`,
      allowedMentions: {
        users: [...new Set([
          interaction.user.id,
          previousClaimedById,
        ])],
      },
    });
    return;
  }

  await interaction.reply({
    content: `🎫 Ticket claimed by <@${interaction.user.id}>.`,
    allowedMentions: {
      users: [interaction.user.id],
    },
  });
}

function sanitizeCodeBlock(value) {
  return String(value).replace(/```/g, '``\u200b`').trim();
}

async function deletePinSystemNotice(channel, pinnedMessageId) {
  await delay(700);

  try {
    const recent = await channel.messages.fetch({ limit: 8, cache: false });
    const notices = recent.filter(
      (message) =>
        message.type === MessageType.ChannelPinnedMessage &&
        message.reference?.messageId === pinnedMessageId,
    );

    for (const notice of notices.values()) {
      await notice.delete().catch(() => {});
    }
  } catch (error) {
    console.error('[TICKET PIN NOTICE CLEANUP ERROR]', error);
  }
}

async function sendAndPinInGameId(channel, creatorId, inGameId) {
  const message = await channel.send({
    content: `**In-game User ID — <@${creatorId}>**\n\`\`\`\n${sanitizeCodeBlock(inGameId)}\n\`\`\``,
    allowedMentions: { parse: [] },
  });

  const pinned = await message.pin('In-game user ID submitted for ticket')
    .then(() => true)
    .catch((error) => {
      console.error('[TICKET PIN ID ERROR]', error);
      return false;
    });

  if (pinned) {
    void deletePinSystemNotice(channel, message.id);
  }

  return message;
}

async function openInGameIdModal(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const data = await getLiveTicketData(interaction.channel);

  if (!data || data.creatorId !== creatorId || interaction.user.id !== creatorId) {
    await interaction.reply({
      content: 'Only the user who created this ticket can submit the in-game ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!TICKET_TYPES[data.typeKey]?.requiresInGameId) {
    await interaction.reply({
      content: 'This ticket does not require an in-game ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.inGameIdStatus === 'done') {
    await interaction.reply({
      content: 'Your in-game ID has already been submitted.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket_ingame_id_modal:${creatorId}`)
    .setTitle('Submit In-game ID');

  const input = new TextInputBuilder()
    .setCustomId('ingame_id')
    .setLabel('In-game user ID')
    .setPlaceholder('Enter your in-game user ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleInGameIdModal(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const data = await getLiveTicketData(interaction.channel);

  if (!data || data.creatorId !== creatorId || interaction.user.id !== creatorId) {
    await interaction.reply({
      content: 'This form is no longer valid for this ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.inGameIdStatus === 'done') {
    await interaction.reply({
      content: 'Your in-game ID has already been submitted.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const inGameId = interaction.fields.getTextInputValue('ingame_id').trim();
  if (!inGameId) {
    await interaction.reply({
      content: 'Please enter a valid in-game user ID.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await sendAndPinInGameId(interaction.channel, creatorId, inGameId);
    const nextData = await updateTicketTopic(
      interaction.channel,
      data,
      { inGameIdStatus: 'done' },
      `In-game ID submitted by ${interaction.user.tag}`,
    );

    if (shouldCreatorBeUnlocked(nextData)) {
      await setCreatorTyping(
        interaction.channel,
        creatorId,
        true,
        `Ticket requirements completed by ${interaction.user.tag}`,
      );
      if (data.typeKey === 'muted_without_reason') {
        const evidenceEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🔇 Mute appeal evidence')
          .setDescription(
            'Your in-game ID has been received and you can now type.\n\n' +
              'Please explain why you believe the mute was not justified and provide any evidence you have, such as screenshots, videos, message links, dates/times, or other relevant context.\n\n' +
              'If you know who muted you, the staff selector on the ticket message is optional — you can select the person you suspect or choose **Skip / Not sure**.',
          );

        await interaction.channel.send({
          content: `<@${creatorId}>`,
          embeds: [evidenceEmbed],
          allowedMentions: { users: [creatorId] },
        });
      } else {
        await interaction.channel.send({
          content: `<@${creatorId}> ✅ Your required details are submitted. You can now type in this ticket.`,
          allowedMentions: { users: [creatorId] },
        });
      }
    } else if (data.typeKey === 'youtuber_submission') {
      await interaction.channel.send({
        content: `<@${creatorId}> ✅ In-game ID received. Now choose your subscriber range and submit your YouTube channel link.`,
        allowedMentions: { users: [creatorId] },
      });
    }

    await interaction.editReply('✅ Your in-game ID has been submitted and pinned for staff.');
  } catch (error) {
    console.error('[TICKET IN-GAME ID ERROR]', error);
    await interaction.editReply('I could not save your in-game ID. Please try again or wait for staff.');
  }
}

async function openYouTubeLinkModal(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const rangeKey = interaction.values[0];
  const data = await getLiveTicketData(interaction.channel);

  if (!data || data.typeKey !== 'youtuber_submission' || data.creatorId !== creatorId) {
    await interaction.reply({
      content: 'This YouTube menu is no longer valid for this ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.user.id !== creatorId) {
    await interaction.reply({
      content: 'Only the user who created this ticket can submit the YouTube channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.youtubeStatus === 'done') {
    await interaction.reply({
      content: 'Your YouTube submission has already been sent.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!YOUTUBE_RANGES[rangeKey]) {
    await interaction.reply({
      content: 'That subscriber range is no longer valid. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket_youtube_link:${creatorId}:${rangeKey}`)
    .setTitle('YouTube Channel Submission');

  const linkInput = new TextInputBuilder()
    .setCustomId('youtube_link')
    .setLabel('YouTube channel link')
    .setPlaceholder('https://youtube.com/@yourchannel')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(300);

  modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
  await interaction.showModal(modal);
}

function parseYouTubeIdentifier(rawInput) {
  const input = String(rawInput).trim();

  if (/^UC[\w-]{20,}$/i.test(input)) {
    return { kind: 'id', value: input };
  }

  if (/^@[\w.-]+$/i.test(input)) {
    return { kind: 'handle', value: input };
  }

  let url;
  try {
    url = new URL(input.startsWith('http') ? input : `https://${input}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!['youtube.com', 'm.youtube.com'].includes(host)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;

  if (parts[0] === 'channel' && parts[1]) return { kind: 'id', value: parts[1] };
  if (parts[0].startsWith('@')) return { kind: 'handle', value: parts[0] };
  if (parts[0] === 'user' && parts[1]) return { kind: 'username', value: parts[1] };
  if (parts[0] === 'c' && parts[1]) return { kind: 'search', value: parts[1] };

  return null;
}

async function youtubeApiGet(path, params, apiKey) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('key', apiKey);

  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = body?.error?.message || `YouTube API returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}

async function fetchYouTubeChannelById(channelId, apiKey) {
  const body = await youtubeApiGet(
    'channels',
    { part: 'snippet,statistics', id: channelId, maxResults: 1 },
    apiKey,
  );
  return body.items?.[0] || null;
}

async function resolveYouTubeChannel(rawInput, apiKey) {
  if (!apiKey) return { status: 'no_api_key' };

  const identifier = parseYouTubeIdentifier(rawInput);
  if (!identifier) return { status: 'invalid_link' };

  let item = null;

  if (identifier.kind === 'id') {
    item = await fetchYouTubeChannelById(identifier.value, apiKey);
  } else if (identifier.kind === 'handle' || identifier.kind === 'username') {
    const filterName = identifier.kind === 'handle' ? 'forHandle' : 'forUsername';
    const body = await youtubeApiGet(
      'channels',
      { part: 'snippet,statistics', [filterName]: identifier.value, maxResults: 1 },
      apiKey,
    );
    item = body.items?.[0] || null;
  } else if (identifier.kind === 'search') {
    const search = await youtubeApiGet(
      'search',
      { part: 'snippet', type: 'channel', maxResults: 5, q: identifier.value },
      apiKey,
    );
    const channelId = search.items?.[0]?.snippet?.channelId;
    if (channelId) item = await fetchYouTubeChannelById(channelId, apiKey);
  }

  if (!item) return { status: 'not_found' };

  return {
    status: 'found',
    id: item.id,
    title: item.snippet?.title || 'Unknown channel',
    customUrl: item.snippet?.customUrl || null,
    thumbnail: item.snippet?.thumbnails?.default?.url || null,
    hiddenSubscriberCount: Boolean(item.statistics?.hiddenSubscriberCount),
    subscriberCount: item.statistics?.subscriberCount !== undefined
      ? Number(item.statistics.subscriberCount)
      : null,
  };
}

function rangeMatches(rangeKey, subscriberCount) {
  const range = YOUTUBE_RANGES[rangeKey];
  if (!range || !Number.isFinite(subscriberCount)) return null;
  return subscriberCount >= range.min && subscriberCount <= range.max;
}

function buildYouTubeResultEmbed(result, rangeKey, submittedLink) {
  const selectedRange = YOUTUBE_RANGES[rangeKey]?.label || 'Unknown';

  if (result.status !== 'found') {
    const reasons = {
      no_api_key: 'Automatic YouTube checking is not configured. Staff will need to review this submission manually.',
      invalid_link: 'The submitted link could not be recognised as a YouTube channel link.',
      not_found: 'The bot could not find the submitted YouTube channel. Staff will need to review it manually.',
      error: 'The YouTube lookup failed. Staff will need to review this submission manually.',
    };

    return new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('▶️ YouTube Submission')
      .addFields(
        { name: 'Submitted link', value: submittedLink.slice(0, 1024) },
        { name: 'Selected subscribers', value: selectedRange, inline: true },
        { name: 'Staff note', value: reasons[result.status] || reasons.error },
      );
  }

  const subscribers = result.hiddenSubscriberCount
    ? 'Hidden'
    : Number.isFinite(result.subscriberCount)
      ? result.subscriberCount.toLocaleString('en-GB')
      : 'Unavailable';

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('▶️ YouTube Submission')
    .addFields(
      { name: 'Channel', value: `[${result.title}](https://www.youtube.com/channel/${result.id})` },
      { name: 'Subscribers', value: subscribers, inline: true },
      { name: 'Selected subscribers', value: selectedRange, inline: true },
      { name: 'Submitted link', value: submittedLink.slice(0, 1024) },
    )
    .setFooter({ text: `YouTube channel ID: ${result.id}` });

  if (result.thumbnail) embed.setThumbnail(result.thumbnail);
  return embed;
}

async function handleYouTubeLinkModal(interaction) {
  const [, creatorId, rangeKey] = interaction.customId.split(':');
  const data = await getLiveTicketData(interaction.channel);

  if (
    !data ||
    data.typeKey !== 'youtuber_submission' ||
    data.creatorId !== creatorId ||
    interaction.user.id !== creatorId
  ) {
    await interaction.reply({
      content: 'This YouTube form is no longer valid for this ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.youtubeStatus === 'done') {
    await interaction.reply({
      content: 'Your YouTube submission has already been sent.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const submittedLink = interaction.fields.getTextInputValue('youtube_link').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const progressMessage = await interaction.channel.send({
    content: `🔎 Checking the YouTube submission from <@${creatorId}>…`,
    allowedMentions: { parse: [] },
  }).catch(() => null);

  let result;
  try {
    result = await resolveYouTubeChannel(submittedLink, process.env.YOUTUBE_API_KEY);
  } catch (error) {
    console.error('[YOUTUBE LOOKUP ERROR]', error);
    result = { status: 'error' };
  }

  const resultEmbed = buildYouTubeResultEmbed(result, rangeKey, submittedLink);

  if (progressMessage) {
    await progressMessage.delete().catch(() => null);
  }

  await interaction.channel.send({
    content: `<@${creatorId}>`,
    embeds: [resultEmbed],
    allowedMentions: { users: [creatorId] },
  }).catch(() => null);

  let nextData = data;
  try {
    nextData = await updateTicketTopic(
      interaction.channel,
      data,
      { youtubeStatus: 'done' },
      `YouTube submission completed by ${interaction.user.tag}`,
    );
  } catch (error) {
    console.error('[YOUTUBE TOPIC UPDATE ERROR]', error);
  }

  if (shouldCreatorBeUnlocked(nextData)) {
    await setCreatorTyping(
      interaction.channel,
      creatorId,
      true,
      `YouTube ticket requirements completed by ${interaction.user.tag}`,
    ).catch((error) => console.error('[YOUTUBE UNLOCK ERROR]', error));

    await interaction.channel.send({
      content: `<@${creatorId}> ✅ Your YouTube submission steps are complete. You can now type in this ticket while staff review it.`,
      allowedMentions: { users: [creatorId] },
    }).catch(() => null);
  } else {
    await interaction.channel.send({
      content: `<@${creatorId}> ✅ YouTube submission received. You still need to submit your **in-game ID** using the button above.`,
      allowedMentions: { users: [creatorId] },
    }).catch(() => null);
  }

  await interaction.editReply(
    result.status === 'found'
      ? '✅ Your YouTube channel has been checked and the result was posted in the ticket.'
      : '✅ Your YouTube link was submitted. Automatic verification was not complete, so staff will verify it manually.',
  );
}

async function getRoleContext(interaction, creatorId) {
  const guild = interaction.guild;
  const actor = await guild.members.fetch(interaction.user.id).catch(() => null);
  const creator = await guild.members.fetch(creatorId).catch(() => null);
  const botMember = guild.members.me || (await guild.members.fetchMe());

  return { guild, actor, creator, botMember };
}

function canActorManageMember(guild, actor, target) {
  if (guild.ownerId === actor.id) return true;
  if (actor.id === target.id) return false;
  return actor.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

function getAssignableRoles(guild, actor, creator, botMember, allowedRoleIds) {
  if (!canActorManageMember(guild, actor, creator)) return guild.roles.cache.filter(() => false);

  const allowed = new Set(allowedRoleIds);

  return guild.roles.cache
    .filter((role) => {
      if (!allowed.has(role.id)) return false;
      if (role.id === guild.roles.everyone.id) return false;
      if (role.managed) return false;
      if (creator.roles.cache.has(role.id)) return false;
      if (!canActorGiveRole(guild, actor, role)) return false;
      if (!canBotGiveRole(botMember, role)) return false;
      return true;
    })
    .sort((a, b) => b.position - a.position);
}

function buildRolePage(assignableRoles, creatorId, page) {
  const totalPages = Math.max(1, Math.ceil(assignableRoles.size / ROLE_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const roles = [...assignableRoles.values()].slice(
    safePage * ROLE_PAGE_SIZE,
    safePage * ROLE_PAGE_SIZE + ROLE_PAGE_SIZE,
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_role_select:${creatorId}:${safePage}`)
    .setPlaceholder('Select a role to give')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      roles.map((role) => ({
        label: role.name.slice(0, 100),
        value: role.id,
        description: 'Allowed ticket role',
      })),
    );

  const components = [new ActionRowBuilder().addComponents(menu)];

  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_role_page:${creatorId}:${safePage - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(`ticket_role_page:${creatorId}:${safePage + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= totalPages - 1),
      ),
    );
  }

  const first = safePage * ROLE_PAGE_SIZE + 1;
  const last = Math.min((safePage + 1) * ROLE_PAGE_SIZE, assignableRoles.size);

  return {
    content: `Select a role to give to <@${creatorId}>. Showing ${first}-${last} of ${assignableRoles.size}.`,
    components,
    allowedMentions: { parse: [] },
  };
}

async function showRoleMenu(interaction, creatorId, page = 0, update = false) {
  const { guild, actor, creator, botMember } = await getRoleContext(interaction, creatorId);

  if (!actor?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: 'You need **Manage Roles** to use this button.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: 'I need **Manage Roles** before I can give roles.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!creator) {
    await interaction.reply({
      content: 'The user who created this ticket is no longer in the server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = await getGuildConfig(guild);
  if (!config || !config.roleIds.length) {
    await interaction.reply({
      content: 'No ticket roles are configured. Run `/ticket-panel reconfigure:true` to choose them.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const assignableRoles = getAssignableRoles(
    guild,
    actor,
    creator,
    botMember,
    config.roleIds,
  );

  if (!assignableRoles.size) {
    await interaction.reply({
      content:
        'None of the configured ticket roles can currently be given by you. The user may already have them, or your/bot role hierarchy may be too low.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const payload = buildRolePage(assignableRoles, creatorId, page);

  if (update) {
    await interaction.update(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

async function openRoleMenu(interaction) {
  const data = getTicketData(interaction.channel);
  if (!data) {
    await interaction.reply({
      content: 'This button can only be used inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await showRoleMenu(interaction, data.creatorId, 0, false);
}

async function changeRolePage(interaction) {
  const [, creatorId, pageString] = interaction.customId.split(':');
  const data = getTicketData(interaction.channel);

  if (!data || data.creatorId !== creatorId) {
    await interaction.reply({
      content: 'This role menu is no longer valid for this ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await showRoleMenu(interaction, creatorId, Number(pageString) || 0, true);
}

async function giveSelectedRole(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const roleId = interaction.values[0];
  const data = getTicketData(interaction.channel);

  if (!data || data.creatorId !== creatorId) {
    await interaction.update({
      content: 'This role menu is no longer valid for this ticket.',
      components: [],
    });
    return;
  }

  const { guild, actor, creator, botMember } = await getRoleContext(interaction, creatorId);
  const config = await getGuildConfig(guild);
  const role = guild.roles.cache.get(roleId);

  if (!actor?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.update({ content: 'You no longer have **Manage Roles**.', components: [] });
    return;
  }

  if (!creator || !role) {
    await interaction.update({ content: 'That user or role no longer exists.', components: [] });
    return;
  }

  if (!config?.roleIds.includes(roleId)) {
    await interaction.update({
      content: 'That role is no longer in the configured ticket-role list.',
      components: [],
    });
    return;
  }

  const stillAssignable =
    !role.managed &&
    role.id !== guild.roles.everyone.id &&
    !creator.roles.cache.has(role.id) &&
    canActorManageMember(guild, actor, creator) &&
    canActorGiveRole(guild, actor, role) &&
    canBotGiveRole(botMember, role);

  if (!stillAssignable) {
    await interaction.update({
      content: 'That role can no longer be assigned by you or by the bot.',
      components: [],
    });
    return;
  }

  try {
    await creator.roles.add(role, `Ticket role given by ${interaction.user.tag}`);
  } catch (error) {
    console.error('[TICKET ROLE ERROR]', error);
    await interaction.update({
      content: 'I could not give that role. Check the bot role hierarchy and permissions.',
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `✅ Gave **${role.name}** to <@${creator.id}>.`,
    components: [],
    allowedMentions: { parse: [] },
  });

  await interaction.channel.send({
    content: `<@${interaction.user.id}> gave **${role.name}** to <@${creator.id}>.`,
    allowedMentions: { parse: [] },
  });
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
          ),
          buildInGameIdActionRow(
            creatorId,
            data.inGameIdStatus === 'done',
          ),
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
        ),
        buildInGameIdActionRow(
          creatorId,
          data.inGameIdStatus === 'done',
        ),
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
      getTicketButtons('muted_without_reason', nextData.unmuteDecision),
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

async function handleTicketInteraction(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_create') {
      await interaction.reply(buildTicketTypeMenu());
      return true;
    }
    if (interaction.customId === 'ticket_close') return closeTicket(interaction);
    if (interaction.customId === 'ticket_transcript') return sendTranscript(interaction);
    if (interaction.customId === 'ticket_reopen') return reopenTicket(interaction);
    if (interaction.customId === 'ticket_delete') return deleteTicket(interaction);
    if (interaction.customId === 'ticket_claim') return claimTicket(interaction);
    if (interaction.customId === 'ticket_role') return openRoleMenu(interaction);
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
  buildPanelMessage,
  getGuildConfig,
  handleTicketInteraction,
  sendTicketPanelCommand,
};
