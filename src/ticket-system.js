const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');

const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '1212792701423198229';
const TICKET_NAME_PREFIX = 'ticket-';
const ROLE_PAGE_SIZE = 25;

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
      'Need help? Press **Create Ticket** below and I will create a private support channel for you.',
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

function buildTicketWelcome(ticketNumber, creator) {
  const embed = new EmbedBuilder()
    .setColor(0x00d166)
    .setDescription(
      'Support will be with you shortly.\nTo close this ticket use the 🔒 **Close** button below.',
    )
    .setFooter({
      text: `Ticket #${ticketNumber} • Created by ${creator.username}`,
      iconURL: creator.displayAvatarURL(),
    });

  return {
    content: `<@${creator.id}> Welcome`,
    embeds: [embed],
    components: [getTicketButtons()],
    allowedMentions: { users: [creator.id] },
  };
}

function makeTicketTopic(ticketNumber, creatorId, claimedById = null) {
  const claimText = claimedById
    ? `Ticket claimed by <@${claimedById}>`
    : 'Unclaimed';

  return `Ticket #${ticketNumber} | Created by <@${creatorId}> | ${claimText}`;
}

function getTicketData(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  if (!channel.name.startsWith(TICKET_NAME_PREFIX)) return null;

  const topic = channel.topic || '';
  const numberMatch = topic.match(/Ticket #(\d+)/i);
  const creatorMatch = topic.match(/Created by <@!?(\d+)>/i);
  const claimedMatch = topic.match(/Ticket claimed by <@!?(\d+)>/i);

  if (!creatorMatch) return null;

  return {
    number: numberMatch ? Number(numberMatch[1]) : null,
    creatorId: creatorMatch[1],
    claimedById: claimedMatch ? claimedMatch[1] : null,
  };
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

function getNextTicketNumber(guild) {
  let highest = runtimeHighestTicketNumber.get(guild.id) || 0;

  for (const channel of guild.channels.cache.values()) {
    if (channel.parentId !== TICKET_CATEGORY_ID) continue;

    const match = channel.name.match(/^ticket-(\d+)$/i);
    if (!match) continue;

    highest = Math.max(highest, Number(match[1]));
  }

  const next = highest + 1;
  runtimeHighestTicketNumber.set(guild.id, next);
  return next;
}

function mergeOverwrite(map, id, type, allowBits = 0n, denyBits = 0n) {
  const existing = map.get(id) || { id, type, allow: 0n, deny: 0n };

  // A permission cannot be both explicitly allowed and denied in one overwrite.
  existing.allow = (existing.allow | allowBits) & ~denyBits;
  existing.deny = (existing.deny | denyBits) & ~allowBits;

  map.set(id, existing);
}

function buildTicketPermissionOverwrites(guild, category, creatorId, botId) {
  const overwriteMap = new Map();

  // Preserve whatever support-role permissions are already configured on the category.
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

  const ticketMemberPermissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.AttachFiles |
    PermissionFlagsBits.EmbedLinks;

  mergeOverwrite(overwriteMap, creatorId, 1, ticketMemberPermissions, 0n);

  const botPermissions =
    ticketMemberPermissions |
    PermissionFlagsBits.ManageChannels |
    PermissionFlagsBits.ManageMessages;
  mergeOverwrite(overwriteMap, botId, 1, botPermissions, 0n);

  // Staff with either permission need to be able to see the buttons they are allowed to use.
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.roles.everyone.id) continue;
    if (
      !role.permissions.has(PermissionFlagsBits.ManageMessages) &&
      !role.permissions.has(PermissionFlagsBits.ManageRoles) &&
      !role.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      continue;
    }

    mergeOverwrite(overwriteMap, role.id, 0, ticketMemberPermissions, 0n);
  }

  return [...overwriteMap.values()];
}

async function createTicket(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('Tickets can only be created inside a server.');
    return;
  }

  await runTicketCreationQueued(guild.id, async () => {
    const category = await guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null);

    if (!category || category.type !== ChannelType.GuildCategory) {
      await interaction.editReply(
        `I could not find the ticket category \`${TICKET_CATEGORY_ID}\`.`,
      );
      return;
    }

    const botMember = guild.members.me || (await guild.members.fetchMe());
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply('I need the **Manage Channels** permission to create tickets.');
      return;
    }

    const ticketNumber = getNextTicketNumber(guild);
    const permissionOverwrites = buildTicketPermissionOverwrites(
      guild,
      category,
      interaction.user.id,
      botMember.id,
    );

    let channel;
    try {
      channel = await guild.channels.create({
        name: `${TICKET_NAME_PREFIX}${ticketNumber}`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: makeTicketTopic(ticketNumber, interaction.user.id),
        permissionOverwrites,
        reason: `Ticket #${ticketNumber} created by ${interaction.user.tag}`,
      });
    } catch (error) {
      console.error('[TICKET CREATE ERROR]', error);
      await interaction.editReply(
        'I could not create your ticket. Check my channel and permission settings.',
      );
      return;
    }

    try {
      await channel.send(buildTicketWelcome(ticketNumber, interaction.user));
    } catch (error) {
      console.error('[TICKET WELCOME ERROR]', error);
    }

    await interaction.editReply({
      content: `✅ Your ticket has been created: <#${channel.id}>`,
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

  const ticketNumber = data.number ?? Number(interaction.channel.name.replace(TICKET_NAME_PREFIX, ''));

  try {
    await interaction.channel.setTopic(
      makeTicketTopic(ticketNumber, data.creatorId, interaction.user.id),
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

function canActorGiveRole(guild, actor, role) {
  if (!actor.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  if (guild.ownerId === actor.id) return true;
  return actor.roles.highest.comparePositionTo(role) > 0;
}

function canBotGiveRole(botMember, role) {
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  return botMember.roles.highest.comparePositionTo(role) > 0;
}

function getAssignableRoles(guild, actor, creator, botMember) {
  if (!canActorManageMember(guild, actor, creator)) return guild.roles.cache.filter(() => false);

  return guild.roles.cache
    .filter((role) => {
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
        description: `Position ${role.position}`.slice(0, 100),
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
    const payload = {
      content: 'You need **Manage Roles** to use this button.',
      flags: MessageFlags.Ephemeral,
    };
    if (update) await interaction.reply(payload);
    else await interaction.reply(payload);
    return;
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    const payload = {
      content: 'I need **Manage Roles** before I can give roles.',
      flags: MessageFlags.Ephemeral,
    };
    if (update) await interaction.reply(payload);
    else await interaction.reply(payload);
    return;
  }

  if (!creator) {
    const payload = {
      content: 'The user who created this ticket is no longer in the server.',
      flags: MessageFlags.Ephemeral,
    };
    if (update) await interaction.reply(payload);
    else await interaction.reply(payload);
    return;
  }

  const assignableRoles = getAssignableRoles(guild, actor, creator, botMember);

  if (!assignableRoles.size) {
    const payload = {
      content:
        'There are no roles you can give this user. Check your role position, my bot role position, and whether the user already has the role.',
      flags: MessageFlags.Ephemeral,
    };
    if (update) await interaction.reply(payload);
    else await interaction.reply(payload);
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
  const role = guild.roles.cache.get(roleId);

  if (!actor?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.update({ content: 'You no longer have **Manage Roles**.', components: [] });
    return;
  }

  if (!creator || !role) {
    await interaction.update({ content: 'That user or role no longer exists.', components: [] });
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
    if (interaction.customId === 'ticket_create') return createTicket(interaction);
    if (interaction.customId === 'ticket_close') return closeTicket(interaction);
    if (interaction.customId === 'ticket_claim') return claimTicket(interaction);
    if (interaction.customId === 'ticket_role') return openRoleMenu(interaction);
    if (interaction.customId.startsWith('ticket_role_page:')) return changeRolePage(interaction);
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith('ticket_role_select:')
  ) {
    return giveSelectedRole(interaction);
  }

  return false;
}

module.exports = {
  TICKET_CATEGORY_ID,
  buildPanelMessage,
  handleTicketInteraction,
};
