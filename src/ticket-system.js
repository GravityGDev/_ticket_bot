const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { CONFIG_PATH, getServerConfig, setServerConfig } = require('./config-store');

const TICKET_NAME_PREFIX = 'ticket-';
const ROLE_PAGE_SIZE = 25;

const TICKET_TYPES = {
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
const runtimeHighestTicketNumber = new Map();

function getTicketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
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

function buildTicketWelcome(ticketNumber, creator, typeKey) {
  const type = TICKET_TYPES[typeKey] || { label: 'Support', emoji: '🎫' };
  const embed = new EmbedBuilder()
    .setColor(0x00d166)
    .setTitle(`${type.emoji || '🎫'} ${type.label}`)
    .setDescription(`${getTypeInstructions(typeKey)}\n\nTo close this ticket use the 🔒 **Close** button below.`)
    .setFooter({
      text: `Ticket #${ticketNumber} • Created by ${creator.username}`,
      iconURL: creator.displayAvatarURL(),
    });

  const components = [getTicketButtons()];

  if (TICKET_TYPES[typeKey]?.requiresInGameId) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_ingame_id:${creator.id}`)
          .setLabel('Submit In-game ID')
          .setEmoji('🆔')
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }

  if (typeKey === 'youtuber_submission') {
    components.push(buildYouTubeSubscriberMenu(creator.id));
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
  };
}

function makeTicketTopic(ticketNumber, typeKey, creatorId, claimedById = null, state = null) {
  const submission = state || initialSubmissionState(typeKey);
  const claimText = claimedById
    ? `Ticket claimed by <@${claimedById}>`
    : 'Unclaimed';

  return [
    `Ticket #${ticketNumber}`,
    `Type=${typeKey}`,
    `Created by <@${creatorId}>`,
    `IG=${submission.inGameIdStatus}`,
    `YT=${submission.youtubeStatus}`,
    claimText,
  ].join(' | ');
}

function getTicketData(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  if (!channel.name.startsWith(TICKET_NAME_PREFIX)) return null;

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
    claimedById: claimedMatch ? claimedMatch[1] : null,
  };
}

async function updateTicketTopic(channel, data, patch = {}, reason = 'Ticket data updated') {
  const next = { ...data, ...patch };
  await channel.setTopic(
    makeTicketTopic(
      next.number,
      next.typeKey,
      next.creatorId,
      next.claimedById,
      next,
    ),
    reason,
  );
  return next;
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

function getNextTicketNumber(guild, categoryId) {
  const key = `${guild.id}:${categoryId}`;
  let highest = runtimeHighestTicketNumber.get(key) || 0;

  for (const channel of guild.channels.cache.values()) {
    if (channel.parentId !== categoryId) continue;

    const match = channel.name.match(/^ticket-(\d+)(?:_|$)/i);
    if (!match) continue;

    highest = Math.max(highest, Number(match[1]));
  }

  const next = highest + 1;
  runtimeHighestTicketNumber.set(key, next);
  return next;
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
    PermissionFlagsBits.ManageMessages;
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

  const config = await getGuildConfig(guild);
  if (!config) {
    await interaction.editReply({
      content: 'The ticket system has not been configured yet. A staff member needs to run `/ticket-panel` first.',
      components: [],
    });
    return;
  }

  await runTicketCreationQueued(guild.id, async () => {
    const category = await guild.channels.fetch(config.categoryId).catch(() => null);

    if (!category || category.type !== ChannelType.GuildCategory) {
      await interaction.editReply({
        content: 'The configured ticket category no longer exists. Staff need to run `/ticket-panel reconfigure:true`.',
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

    const ticketNumber = getNextTicketNumber(guild, category.id);
    const state = initialSubmissionState(typeKey);
    const creatorCanSend = shouldCreatorBeUnlocked({ typeKey, ...state });
    const permissionOverwrites = buildTicketPermissionOverwrites(
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
      await channel.send(buildTicketWelcome(ticketNumber, interaction.user, typeKey));
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

async function closeTicket(interaction) {
  const data = getTicketData(interaction.channel);
  if (!data) {
    await interaction.reply({
      content: 'This button can only be used inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const isCreator = data.creatorId === interaction.user.id;
  const isStaff =
    interaction.channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageMessages) || false;

  if (!isCreator && !isStaff) {
    await interaction.reply({
      content: 'Only the ticket creator or staff with **Manage Messages** can close this ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: '🔒 Closing this ticket in 3 seconds…' });

  setTimeout(async () => {
    await interaction.channel.delete(`Ticket closed by ${interaction.user.tag}`).catch((error) => {
      console.error('[TICKET CLOSE ERROR]', error);
    });
  }, 3000);
}

async function claimTicket(interaction) {
  const data = getTicketData(interaction.channel);
  if (!data) {
    await interaction.reply({
      content: 'This button can only be used inside a ticket channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (
    !member ||
    !interaction.channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageMessages)
  ) {
    await interaction.reply({
      content: 'You need **Manage Messages** to claim tickets.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (data.claimedById) {
    await interaction.reply({
      content:
        data.claimedById === interaction.user.id
          ? 'You have already claimed this ticket.'
          : `This ticket is already claimed by <@${data.claimedById}>.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    await updateTicketTopic(
      interaction.channel,
      data,
      { claimedById: interaction.user.id },
      `Ticket claimed by ${interaction.user.tag}`,
    );
  } catch (error) {
    console.error('[TICKET CLAIM TOPIC ERROR]', error);
    await interaction.reply({
      content: 'I could not update the channel topic. Make sure I have **Manage Channels**.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Ticket claimed by <@${interaction.user.id}>`,
    allowedMentions: { users: [interaction.user.id] },
  });
}

function sanitizeCodeBlock(value) {
  return String(value).replace(/```/g, '``\u200b`').trim();
}

async function sendAndPinInGameId(channel, creatorId, inGameId) {
  const message = await channel.send({
    content: `**In-game User ID — <@${creatorId}>**\n\`\`\`\n${sanitizeCodeBlock(inGameId)}\n\`\`\``,
    allowedMentions: { parse: [] },
  });

  await message.pin('In-game user ID submitted for ticket').catch((error) => {
    console.error('[TICKET PIN ID ERROR]', error);
  });

  return message;
}

async function openInGameIdModal(interaction) {
  const [, creatorId] = interaction.customId.split(':');
  const data = getTicketData(interaction.channel);

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
  const data = getTicketData(interaction.channel);

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
      await interaction.channel.send({
        content: `<@${creatorId}> ✅ Your required details are submitted. You can now type in this ticket.`,
        allowedMentions: { users: [creatorId] },
      });
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
  const data = getTicketData(interaction.channel);

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
      no_api_key: 'Automatic YouTube checking is not configured, so staff need to verify this submission manually.',
      invalid_link: 'The submitted link could not be recognised as a YouTube channel link.',
      not_found: 'The bot could not find the submitted YouTube channel.',
      error: 'The YouTube lookup failed, so staff need to verify this submission manually.',
    };

    return new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('▶️ YouTube Submission')
      .addFields(
        { name: 'Submitted link', value: submittedLink.slice(0, 1024) },
        { name: 'Selected subscribers', value: selectedRange, inline: true },
        { name: 'Status', value: '⚠️ Awaiting staff verification', inline: true },
        { name: 'Result', value: reasons[result.status] || reasons.error },
      );
  }

  const subscribers = result.hiddenSubscriberCount
    ? 'Hidden'
    : Number.isFinite(result.subscriberCount)
      ? result.subscriberCount.toLocaleString('en-GB')
      : 'Unavailable';
  const matches = result.hiddenSubscriberCount ? null : rangeMatches(rangeKey, result.subscriberCount);
  const rangeStatus = matches === null
    ? 'Unable to compare'
    : matches
      ? '✅ Matches selected range'
      : '⚠️ Does not match selected range';

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('▶️ YouTube Submission Check')
    .addFields(
      { name: 'Channel', value: `[${result.title}](https://www.youtube.com/channel/${result.id})` },
      { name: 'Subscribers', value: subscribers, inline: true },
      { name: 'Selected range', value: selectedRange, inline: true },
      { name: 'Range check', value: rangeStatus },
      {
        name: 'Ownership status',
        value: '⚠️ **Unverified**\nThe bot can verify public channel details, but Discord linked-account ownership requires the user to authorise the `connections` OAuth scope. Staff should verify ownership manually.',
      },
    )
    .setFooter({ text: `YouTube channel ID: ${result.id}` });

  if (result.thumbnail) embed.setThumbnail(result.thumbnail);
  return embed;
}

async function handleYouTubeLinkModal(interaction) {
  const [, creatorId, rangeKey] = interaction.customId.split(':');
  const data = getTicketData(interaction.channel);

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
    await progressMessage.edit({ content: '', embeds: [resultEmbed] }).catch(() => null);
  } else {
    await interaction.channel.send({ embeds: [resultEmbed] }).catch(() => null);
  }

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

async function handleTicketInteraction(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId === 'ticket_create') {
      await interaction.reply(buildTicketTypeMenu());
      return true;
    }
    if (interaction.customId === 'ticket_close') return closeTicket(interaction);
    if (interaction.customId === 'ticket_claim') return claimTicket(interaction);
    if (interaction.customId === 'ticket_role') return openRoleMenu(interaction);
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
