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
  UserSelectMenuBuilder,
} = require('discord.js');
const {
  OWNER_USER_ID,
  getStaffTrackingSettings,
  updateStaffTrackingSettings,
  canManageStaffSettings,
  getStaffGoals,
  createStaffGoal,
  updateStaffGoal,
  deleteStaffGoal,
  getGoalGrant,
  recordGoalGrant,
  getWarningRemovalSchedules,
  createWarningRemovalSchedule,
  updateWarningRemovalSchedule,
  deleteWarningRemovalSchedule,
  claimDueWarningRemovals,
  finishWarningRemoval,
} = require('./staff-settings-store');
const { getStaffMetricCount } = require('./staff-tracking-store');

const goalEvaluationTimers = new Map();

function truncate(value, max = 1000) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function channelMentions(ids) {
  return ids.length ? ids.map((id) => `<#${id}>`).join('\n') : 'None';
}

function userMentions(ids) {
  return ids.length ? ids.map((id) => `<@${id}>`).join('\n') : 'None';
}

function discordTime(date, style = 'f') {
  const value = date instanceof Date ? date : new Date(date);
  return `<t:${Math.floor(value.getTime() / 1000)}:${style}>`;
}

async function assertSettingsAccess(interaction, { ownerOnly = false } = {}) {
  if (!interaction.guild) return false;

  if (ownerOnly) {
    if (interaction.user.id === OWNER_USER_ID) return true;

    await interaction.reply({
      content: 'Only the bot owner can manage **Settings Editors**.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return false;
  }

  if (await canManageStaffSettings(interaction.guild.id, interaction.user.id)) {
    return true;
  }

  await interaction.reply({
    content: 'You are not authorised to edit the staff tracking settings.',
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  return false;
}

async function buildSettingsHome(guild) {
  const [settings, goals, schedules] = await Promise.all([
    getStaffTrackingSettings(guild.id, { fresh: true }),
    getStaffGoals(guild.id),
    getWarningRemovalSchedules(guild.id),
  ]);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('⚙️ Staff Tracking Settings')
    .setDescription(
      'Changes affect **new activity going forward**. Existing MongoDB statistics are kept.',
    )
    .addFields(
      {
        name: `📁 Tracked Categories • ${settings.trackedCategoryIds.length}`,
        value: truncate(channelMentions(settings.trackedCategoryIds)),
      },
      {
        name: `🚫 Channel Blacklist • ${settings.blacklistedChannelIds.length}`,
        value: truncate(channelMentions(settings.blacklistedChannelIds)),
      },
      {
        name: `✅ Extra Whitelisted Channels • ${settings.whitelistedChannelIds.length}`,
        value: truncate(channelMentions(settings.whitelistedChannelIds)),
      },
      {
        name: `👥 Settings Editors • ${settings.editorUserIds.length}`,
        value: truncate(userMentions(settings.editorUserIds)),
      },
      {
        name: '🎯 Goal Rewards',
        value: `${goals.length} configured`,
        inline: true,
      },
      {
        name: '⏰ Warning Removals',
        value: `${schedules.length} pending`,
        inline: true,
      },
    )
    .setFooter({
      text: `Owner: ${OWNER_USER_ID}`,
    })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:categories')
          .setLabel('Categories')
          .setEmoji('📁')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('staffsettings:blacklist')
          .setLabel('Blacklist')
          .setEmoji('🚫')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('staffsettings:whitelist')
          .setLabel('Whitelist')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('staffsettings:goals')
          .setLabel('Goal Rewards')
          .setEmoji('🎯')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('staffsettings:warnings')
          .setLabel('Warn Removal')
          .setEmoji('⏰')
          .setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:editors')
          .setLabel('Settings Editors')
          .setEmoji('👥')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('staffsettings:dashboard')
          .setLabel('Back to Dashboard')
          .setEmoji('🏆')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildTrackingListPage(kind, settings) {
  const definitions = {
    categories: {
      title: '📁 Tracked Categories',
      description:
        'Messages from staff with **View Audit Log** are counted in channels under these categories. Select the **complete category list** you want to track.',
      current: settings.trackedCategoryIds,
      customId: 'staffsettings:setcategories',
      placeholder: 'Select tracked categories',
      clearId: 'staffsettings:clearcategories',
      channelTypes: [ChannelType.GuildCategory],
    },
    blacklist: {
      title: '🚫 Channel Blacklist',
      description:
        'Blacklisted channels are never counted, even when they are inside a tracked category. Select the **complete blacklist**.',
      current: settings.blacklistedChannelIds,
      customId: 'staffsettings:setblacklist',
      placeholder: 'Select blacklisted channels',
      clearId: 'staffsettings:clearblacklist',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    },
    whitelist: {
      title: '✅ Extra Whitelisted Channels',
      description:
        'These channels are counted even when they are outside your tracked categories. Blacklist still takes priority. Select the **complete whitelist**.',
      current: settings.whitelistedChannelIds,
      customId: 'staffsettings:setwhitelist',
      placeholder: 'Select extra tracked channels',
      clearId: 'staffsettings:clearwhitelist',
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    },
  };

  const def = definitions[kind];
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(def.customId)
    .setPlaceholder(def.placeholder)
    .setMinValues(1)
    .setMaxValues(25)
    .setChannelTypes(...def.channelTypes);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(def.title)
    .setDescription(def.description)
    .addFields({
      name: `Current • ${def.current.length}`,
      value: truncate(channelMentions(def.current)),
    });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(def.clearId)
          .setLabel('Clear All')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('staffsettings:home')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function buildEditorsPage(guild) {
  const settings = await getStaffTrackingSettings(guild.id, { fresh: true });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('👥 Settings Editors')
    .setDescription(
      `The owner <@${OWNER_USER_ID}> always has access. Add trusted staff here so they can change tracking rules, goals and warning-removal schedules. Only the owner can edit this list.`,
    )
    .addFields({
      name: `Current Editors • ${settings.editorUserIds.length}`,
      value: truncate(userMentions(settings.editorUserIds)),
    });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('staffsettings:seteditors')
          .setPlaceholder('Select the complete editor list')
          .setMinValues(1)
          .setMaxValues(25),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:cleareditors')
          .setLabel('Clear Editors')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('staffsettings:home')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function goalSummary(goal) {
  const metric = goal.metric === 'tickets' ? 'tickets claimed' : 'tracked messages';
  return `**${goal.name}** — ${goal.threshold} ${metric} • ${goal.period} • reward <@&${goal.rewardRoleId}>`;
}

async function buildGoalsPage(guild) {
  const goals = await getStaffGoals(guild.id);
  const value = goals.length
    ? goals.map((goal, index) => `${index + 1}. ${goalSummary(goal)}`).join('\n')
    : 'No goal rewards configured.';

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🎯 Automatic Goal Rewards')
        .setDescription(
          'Create fully custom ticket/message goals. When a staff member reaches a goal, the bot automatically grants the configured reward role.',
        )
        .addFields({ name: `Goals • ${goals.length}/25`, value: truncate(value) }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:goaladd')
          .setLabel('Add Goal')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success)
          .setDisabled(goals.length >= 25),
        new ButtonBuilder()
          .setCustomId('staffsettings:goaledit')
          .setLabel('Edit Goal')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!goals.length),
        new ButtonBuilder()
          .setCustomId('staffsettings:goalremove')
          .setLabel('Remove Goal')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!goals.length),
        new ButtonBuilder()
          .setCustomId('staffsettings:home')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildGoalSelect(goals, mode) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(mode === 'remove' ? 0xed4245 : 0x5865f2)
        .setTitle(mode === 'remove' ? '🗑️ Remove Goal' : '✏️ Edit Goal')
        .setDescription('Choose a goal below.'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`staffsettings:goalselect:${mode}`)
          .setPlaceholder(mode === 'remove' ? 'Select goal to remove' : 'Select goal to edit')
          .addOptions(
            goals.map((goal) => ({
              label: truncate(goal.name, 100),
              description: truncate(
                `${goal.threshold} ${goal.metric} • ${goal.period} • role ${goal.rewardRoleId}`,
                100,
              ),
              value: String(goal._id),
            })),
          ),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:goals')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildGoalModal(mode, goal = null) {
  const editing = mode === 'edit';
  const modal = new ModalBuilder()
    .setCustomId(
      editing ? `staffsettings:goalmodal:edit:${goal._id}` : 'staffsettings:goalmodal:add',
    )
    .setTitle(editing ? 'Edit Staff Goal' : 'Add Staff Goal');

  const inputs = [
    new TextInputBuilder()
      .setCustomId('name')
      .setLabel('Goal name')
      .setPlaceholder('Example: Ticket Champion')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80)
      .setValue(editing ? String(goal.name) : ''),
    new TextInputBuilder()
      .setCustomId('metric')
      .setLabel('Metric: tickets or messages')
      .setPlaceholder('tickets')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(editing ? String(goal.metric) : 'tickets'),
    new TextInputBuilder()
      .setCustomId('threshold')
      .setLabel('Required amount')
      .setPlaceholder('400')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(editing ? String(goal.threshold) : ''),
    new TextInputBuilder()
      .setCustomId('rewardRoleId')
      .setLabel('Reward role ID')
      .setPlaceholder('955029841793650688')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(editing ? String(goal.rewardRoleId) : ''),
    new TextInputBuilder()
      .setCustomId('period')
      .setLabel('Period: lifetime/weekly/monthly/quarterly')
      .setPlaceholder('lifetime')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(editing ? String(goal.period) : 'lifetime'),
  ];

  modal.addComponents(
    ...inputs.map((input) => new ActionRowBuilder().addComponents(input)),
  );
  return modal;
}

function warningScheduleSummary(schedule) {
  const reason = schedule.reason
    ? ` • Reason: ${truncate(schedule.reason, 80)}`
    : '';

  return `<@${schedule.userId}> • remove <@&${schedule.roleId}> • ${discordTime(schedule.executeAt, 'f')} (${discordTime(schedule.executeAt, 'R')})${reason}`;
}

async function buildWarningsPage(guild) {
  const schedules = await getWarningRemovalSchedules(guild.id);
  const value = schedules.length
    ? schedules.map((item, index) => `${index + 1}. ${warningScheduleSummary(item)}`).join('\n')
    : 'No warning-role removals scheduled.';

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle('⏰ Scheduled Warning Role Removal')
        .setDescription(
          'Choose a user, choose the role to remove, then set the exact removal date/time. The bot checks pending removals every minute.',
        )
        .addFields({ name: `Pending • ${schedules.length}/25`, value: truncate(value) }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:warnadd')
          .setLabel('Set Removal for Staff')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success)
          .setDisabled(schedules.length >= 25),
        new ButtonBuilder()
          .setCustomId('staffsettings:warnedit')
          .setLabel('Edit Date/Time')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!schedules.length),
        new ButtonBuilder()
          .setCustomId('staffsettings:warnremove')
          .setLabel('Remove Schedule')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!schedules.length),
        new ButtonBuilder()
          .setCustomId('staffsettings:home')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildWarningSelect(schedules, mode) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(mode === 'remove' ? 0xed4245 : 0x5865f2)
        .setTitle(mode === 'remove' ? '🗑️ Remove Warning Schedule' : '✏️ Edit Warning Schedule')
        .setDescription('Choose the scheduled warning-role removal.'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`staffsettings:warnselect:${mode}`)
          .setPlaceholder('Select scheduled removal')
          .addOptions(
            schedules.map((schedule) => ({
              label: truncate(`User ${schedule.userId}`, 100),
              description: truncate(
                `Role ${schedule.roleId} • ${new Date(schedule.executeAt).toISOString()}`,
                100,
              ),
              value: String(schedule._id),
            })),
          ),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('staffsettings:warnings')
          .setLabel('Back')
          .setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function parseLondonLocalDateTime(input) {
  const value = String(input || '').trim();

  if (/^\d{10,13}$/.test(value)) {
    const number = Number(value);
    const milliseconds = value.length <= 10 ? number * 1000 : number;
    return new Date(milliseconds);
  }

  if (/^<t:\d+(?::[tTdDfFR])?>$/.test(value)) {
    const seconds = Number(value.match(/\d+/)[0]);
    return new Date(seconds * 1000);
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return new Date(value);
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) {
    throw new Error(
      'Use `YYYY-MM-DD HH:mm` (UK time), a Unix timestamp, or ISO time with an offset.',
    );
  }

  const [, y, mo, d, h, mi, s = '00'] = match;
  const desiredUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  let guess = new Date(desiredUtc);

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(guess)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    const representedUtc = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second,
    );
    const delta = desiredUtc - representedUtc;
    if (!delta) break;
    guess = new Date(guess.getTime() + delta);
  }

  return guess;
}

function buildWarningDateModal(mode, scheduleOrData) {
  const editing = mode === 'edit';
  const modal = new ModalBuilder()
    .setCustomId(
      editing
        ? `staffsettings:warnmodal:edit:${scheduleOrData._id}`
        : `staffsettings:warnmodal:add:${scheduleOrData.userId}:${scheduleOrData.roleId}`,
    )
    .setTitle(editing ? 'Edit Warning Removal Time' : 'Schedule Warning Removal');

  const dateValue = editing
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(scheduleOrData.executeAt)).replace(',', '')
    : '';

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('datetime')
        .setLabel('Removal date/time (UK time)')
        .setPlaceholder('2026-09-01 18:30')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(dateValue),
    ),
  );

  return modal;
}

async function validateRewardRole(guild, roleId) {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) throw new Error('Reward role does not exist in this server.');
  if (role.managed) throw new Error('That reward role is managed by an integration and cannot be assigned.');

  const botMember = guild.members.me || (await guild.members.fetchMe());
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('The bot needs Manage Roles to grant goal rewards.');
  }
  if (role.position >= botMember.roles.highest.position) {
    throw new Error('Move the bot role above the reward role in the server role list.');
  }

  return role;
}

async function evaluateStaffGoalsForMember(guild, staffId) {
  if (!guild || !staffId) return;

  const member = await guild.members.fetch(String(staffId)).catch(() => null);
  if (!member || member.user.bot) return;
  if (!member.permissions.has(PermissionFlagsBits.ViewAuditLog)) return;

  const goals = await getStaffGoals(guild.id);
  for (const goal of goals) {
    const existingGrant = await getGoalGrant(guild.id, String(goal._id), member.id);
    if (existingGrant) continue;

    const value = await getStaffMetricCount(
      guild.id,
      member.id,
      goal.metric,
      goal.period,
    );
    if (value < goal.threshold) continue;

    try {
      const role = await validateRewardRole(guild, goal.rewardRoleId);
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(
          role,
          `Staff goal reached: ${goal.name} (${value}/${goal.threshold} ${goal.metric})`,
        );
      }
      await recordGoalGrant(guild.id, goal, member.id, value);
      console.log(
        `[STAFF GOAL REWARD] ${member.user.tag} reached "${goal.name}" ` +
          `(${value}/${goal.threshold}); reward role ${role.id} granted/confirmed.`,
      );
    } catch (error) {
      console.error(`[STAFF GOAL REWARD ERROR] goal=${goal._id} staff=${member.id}`, error);
    }
  }
}

async function evaluateAllStaffGoals(guild) {
  if (!guild) return;

  try {
    await guild.members.fetch();
  } catch (error) {
    console.error('[STAFF GOAL FULL MEMBER FETCH ERROR]', error);
  }

  const staff = [...guild.members.cache.values()].filter(
    (member) =>
      !member.user.bot &&
      member.permissions.has(PermissionFlagsBits.ViewAuditLog),
  );

  for (const member of staff) {
    await evaluateStaffGoalsForMember(guild, member.id);
  }
}

function queueStaffGoalEvaluation(guild, staffId) {
  if (!guild || !staffId) return;
  const key = `${guild.id}:${staffId}`;
  if (goalEvaluationTimers.has(key)) return;

  const timer = setTimeout(() => {
    goalEvaluationTimers.delete(key);
    evaluateStaffGoalsForMember(guild, staffId).catch((error) => {
      console.error('[STAFF GOAL EVALUATION ERROR]', error);
    });
  }, 5000);

  timer.unref?.();
  goalEvaluationTimers.set(key, timer);
}

async function processDueWarningRemovals(client) {
  const schedules = await claimDueWarningRemovals(25);

  for (const schedule of schedules) {
    try {
      const guild =
        client.guilds.cache.get(schedule.guildId) ||
        (await client.guilds.fetch(schedule.guildId).catch(() => null));
      if (!guild) throw new Error('Guild is no longer accessible to the bot.');

      const member = await guild.members.fetch(schedule.userId).catch(() => null);
      if (!member) throw new Error('Scheduled member is no longer in the server.');

      const role = await guild.roles.fetch(schedule.roleId).catch(() => null);
      if (!role) throw new Error('Scheduled role no longer exists.');

      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(
          role,
          `Scheduled warning role removal created by ${schedule.createdBy}`,
        );
      }

      await finishWarningRemoval(String(schedule._id), 'completed', {
        completedGuildId: guild.id,
        completedUserId: member.id,
        completedRoleId: role.id,
      });

      console.log(
        `[WARNING ROLE REMOVAL] ${role.name} removed/confirmed absent from ${member.user.tag}.`,
      );
    } catch (error) {
      console.error('[WARNING ROLE REMOVAL ERROR]', error);
      await finishWarningRemoval(String(schedule._id), 'failed', {
        error: String(error?.message || error),
      });
    }
  }
}

async function handleStaffSettingsInteraction(interaction, dashboardBuilder) {
  const customId = interaction.customId || '';
  if (!customId.startsWith('staffsettings:')) return false;

  const action = customId.split(':')[1];
  const ownerOnly = ['editors', 'seteditors', 'cleareditors'].includes(action);
  if (!(await assertSettingsAccess(interaction, { ownerOnly }))) return true;

  try {
    if (action === 'home') {
      await interaction.update(await buildSettingsHome(interaction.guild));
      return true;
    }

    if (action === 'dashboard') {
      await interaction.update(
        await dashboardBuilder(interaction.guild, {
          periodKey: 'weekly',
          filterKey: 'all',
          page: 0,
          viewerId: interaction.user.id,
        }),
      );
      return true;
    }

    if (['categories', 'blacklist', 'whitelist'].includes(action)) {
      const settings = await getStaffTrackingSettings(interaction.guild.id, { fresh: true });
      await interaction.update(buildTrackingListPage(action, settings));
      return true;
    }

    if (['setcategories', 'setblacklist', 'setwhitelist'].includes(action)) {
      if (!interaction.isChannelSelectMenu()) return true;
      const patchKey = {
        setcategories: 'trackedCategoryIds',
        setblacklist: 'blacklistedChannelIds',
        setwhitelist: 'whitelistedChannelIds',
      }[action];

      await updateStaffTrackingSettings(
        interaction.guild.id,
        { [patchKey]: interaction.values },
        interaction.user.id,
      );

      const settings = await getStaffTrackingSettings(interaction.guild.id, { fresh: true });
      const kind = {
        setcategories: 'categories',
        setblacklist: 'blacklist',
        setwhitelist: 'whitelist',
      }[action];
      await interaction.update(buildTrackingListPage(kind, settings));
      return true;
    }

    if (['clearcategories', 'clearblacklist', 'clearwhitelist'].includes(action)) {
      const patchKey = {
        clearcategories: 'trackedCategoryIds',
        clearblacklist: 'blacklistedChannelIds',
        clearwhitelist: 'whitelistedChannelIds',
      }[action];
      await updateStaffTrackingSettings(
        interaction.guild.id,
        { [patchKey]: [] },
        interaction.user.id,
      );
      const settings = await getStaffTrackingSettings(interaction.guild.id, { fresh: true });
      const kind = {
        clearcategories: 'categories',
        clearblacklist: 'blacklist',
        clearwhitelist: 'whitelist',
      }[action];
      await interaction.update(buildTrackingListPage(kind, settings));
      return true;
    }

    if (action === 'editors') {
      await interaction.update(await buildEditorsPage(interaction.guild));
      return true;
    }

    if (action === 'seteditors' && interaction.isUserSelectMenu()) {
      const validEditors = [];
      for (const userId of interaction.values) {
        if (userId === OWNER_USER_ID) continue;
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (
          member &&
          !member.user.bot &&
          member.permissions.has(PermissionFlagsBits.ViewAuditLog)
        ) {
          validEditors.push(userId);
        }
      }

      await updateStaffTrackingSettings(
        interaction.guild.id,
        { editorUserIds: validEditors },
        interaction.user.id,
      );
      await interaction.update(await buildEditorsPage(interaction.guild));
      return true;
    }

    if (action === 'cleareditors') {
      await updateStaffTrackingSettings(
        interaction.guild.id,
        { editorUserIds: [] },
        interaction.user.id,
      );
      await interaction.update(await buildEditorsPage(interaction.guild));
      return true;
    }

    if (action === 'goals') {
      await interaction.update(await buildGoalsPage(interaction.guild));
      return true;
    }

    if (action === 'goaladd') {
      await interaction.showModal(buildGoalModal('add'));
      return true;
    }

    if (['goaledit', 'goalremove'].includes(action)) {
      const goals = await getStaffGoals(interaction.guild.id);
      if (!goals.length) {
        await interaction.update(await buildGoalsPage(interaction.guild));
        return true;
      }
      await interaction.update(buildGoalSelect(goals, action === 'goaledit' ? 'edit' : 'remove'));
      return true;
    }

    if (action === 'goalselect' && interaction.isStringSelectMenu()) {
      const mode = customId.split(':')[2];
      const goalId = interaction.values[0];
      const goals = await getStaffGoals(interaction.guild.id);
      const goal = goals.find((item) => String(item._id) === String(goalId));
      if (!goal) throw new Error('Goal no longer exists.');

      if (mode === 'remove') {
        await deleteStaffGoal(interaction.guild.id, goalId);
        await interaction.update(await buildGoalsPage(interaction.guild));
      } else {
        await interaction.showModal(buildGoalModal('edit', goal));
      }
      return true;
    }

    if (action === 'goalmodal' && interaction.isModalSubmit()) {
      const mode = customId.split(':')[2];
      const goalId = customId.split(':')[3];
      const input = {
        name: interaction.fields.getTextInputValue('name'),
        metric: interaction.fields.getTextInputValue('metric'),
        threshold: interaction.fields.getTextInputValue('threshold'),
        rewardRoleId: interaction.fields.getTextInputValue('rewardRoleId'),
        period: interaction.fields.getTextInputValue('period'),
      };

      await validateRewardRole(interaction.guild, input.rewardRoleId);
      if (mode === 'edit') {
        await updateStaffGoal(interaction.guild.id, goalId, input, interaction.user.id);
      } else {
        await createStaffGoal(interaction.guild.id, input, interaction.user.id);
      }

      await evaluateAllStaffGoals(interaction.guild).catch((error) => {
        console.error('[STAFF GOAL POST-SAVE EVALUATION ERROR]', error);
      });

      await interaction.reply({
        content: `✅ Goal ${mode === 'edit' ? 'updated' : 'created'}.`,
        flags: MessageFlags.Ephemeral,
        ...(await buildGoalsPage(interaction.guild)),
      });
      return true;
    }

    if (action === 'warnings') {
      await interaction.update(await buildWarningsPage(interaction.guild));
      return true;
    }

    if (action === 'warnadd') {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0xfaa61a)
            .setTitle('⏰ Schedule Warning Removal • Step 1/3')
            .setDescription('Select the staff member whose role should be removed.'),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId('staffsettings:warnuser')
              .setPlaceholder('Select staff member')
              .setMinValues(1)
              .setMaxValues(1),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('staffsettings:warnings')
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return true;
    }

    if (action === 'warnuser' && interaction.isUserSelectMenu()) {
      const userId = interaction.values[0];
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0xfaa61a)
            .setTitle('⏰ Schedule Warning Removal • Step 2/3')
            .setDescription(`Selected <@${userId}>. Now select the role that should be removed.`),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId(`staffsettings:warnrole:${userId}`)
              .setPlaceholder('Select role to remove')
              .setMinValues(1)
              .setMaxValues(1),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('staffsettings:warnings')
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return true;
    }

    if (action === 'warnrole' && interaction.isRoleSelectMenu()) {
      const userId = customId.split(':')[2];
      const roleId = interaction.values[0];
      await interaction.showModal(buildWarningDateModal('add', { userId, roleId }));
      return true;
    }

    if (['warnedit', 'warnremove'].includes(action)) {
      const schedules = await getWarningRemovalSchedules(interaction.guild.id);
      if (!schedules.length) {
        await interaction.update(await buildWarningsPage(interaction.guild));
        return true;
      }
      await interaction.update(
        buildWarningSelect(schedules, action === 'warnedit' ? 'edit' : 'remove'),
      );
      return true;
    }

    if (action === 'warnselect' && interaction.isStringSelectMenu()) {
      const mode = customId.split(':')[2];
      const scheduleId = interaction.values[0];
      const schedules = await getWarningRemovalSchedules(interaction.guild.id);
      const schedule = schedules.find((item) => String(item._id) === String(scheduleId));
      if (!schedule) throw new Error('Schedule no longer exists.');

      if (mode === 'remove') {
        await deleteWarningRemovalSchedule(interaction.guild.id, scheduleId);
        await interaction.update(await buildWarningsPage(interaction.guild));
      } else {
        await interaction.showModal(buildWarningDateModal('edit', schedule));
      }
      return true;
    }

    if (action === 'warnmodal' && interaction.isModalSubmit()) {
      const mode = customId.split(':')[2];
      const date = parseLondonLocalDateTime(
        interaction.fields.getTextInputValue('datetime'),
      );

      if (mode === 'add') {
        const userId = customId.split(':')[3];
        const roleId = customId.split(':')[4];
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!member) throw new Error('Selected user is not in this server.');
        if (!role) throw new Error('Selected role no longer exists.');

        const botMember = interaction.guild.members.me || (await interaction.guild.members.fetchMe());
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          throw new Error('The bot needs Manage Roles for scheduled removals.');
        }
        if (role.managed || role.position >= botMember.roles.highest.position) {
          throw new Error('The bot cannot manage that role. Move the bot role higher or choose another role.');
        }

        await createWarningRemovalSchedule(
          interaction.guild.id,
          { userId, roleId, executeAt: date },
          interaction.user.id,
        );
      } else {
        const scheduleId = customId.split(':')[3];
        await updateWarningRemovalSchedule(
          interaction.guild.id,
          scheduleId,
          date,
          interaction.user.id,
        );
      }

      await interaction.reply({
        content: `✅ Warning-role removal ${mode === 'add' ? 'scheduled' : 'updated'} for ${discordTime(date, 'f')}.`,
        flags: MessageFlags.Ephemeral,
        ...(await buildWarningsPage(interaction.guild)),
      });
      return true;
    }
  } catch (error) {
    console.error('[STAFF SETTINGS ERROR]', error);
    const response = {
      content: `I could not update the staff settings: ${error?.message || 'Unknown error'}`,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(response).catch(() => {});
    }
    return true;
  }

  return true;
}

module.exports = {
  OWNER_USER_ID,
  canManageStaffSettings,
  buildSettingsHome,
  handleStaffSettingsInteraction,
  evaluateStaffGoalsForMember,
  evaluateAllStaffGoals,
  queueStaffGoalEvaluation,
  processDueWarningRemovals,
  parseLondonLocalDateTime,
};
