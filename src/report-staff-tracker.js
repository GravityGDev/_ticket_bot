const {
  ActionRowBuilder,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { getMongoDb } = require('./database');
const { getTicketState } = require('./ticket-store');

const REPORT_STAFF_CATEGORY_ID = '1194859845426364497';

// This is a USER ID, not a guild channel ID.
// Manual-deletion transcripts are sent directly to this user's DMs.
const REPORT_STAFF_SECURITY_USER_ID =
  process.env.REPORT_STAFF_SECURITY_USER_ID || '1150135578378125383';

const ARCHIVE_COLLECTION = 'report_staff_archives';
const MESSAGE_COLLECTION = 'report_staff_messages';

const pendingChannelWrites = new Map();

function isReportStaffChannel(channel) {
  if (!channel || !channel.guild) return false;

  // A category can contain non-ticket channels. Only the immutable ticket
  // topic marker proves this is a genuine Report Staff ticket. The topic is
  // also retained on ChannelDelete events and survives staff channel renames.
  return Boolean(
    typeof channel.topic === 'string' &&
      /(?:^|\|)\s*Type=report_staff(?:\s*\||$)/i.test(
        channel.topic,
      ),
  );
}

function queueChannelWrite(channelId, task) {
  const key = String(channelId);
  const previous = pendingChannelWrites.get(key) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (pendingChannelWrites.get(key) === next) {
        pendingChannelWrites.delete(key);
      }
    });

  pendingChannelWrites.set(key, next);
  return next;
}

async function waitForPendingChannelWrites(channelId) {
  const pending = pendingChannelWrites.get(String(channelId));
  if (pending) {
    await pending.catch(() => {});
  }
}

async function archiveCollection() {
  return (await getMongoDb()).collection(ARCHIVE_COLLECTION);
}

async function messageCollection() {
  return (await getMongoDb()).collection(MESSAGE_COLLECTION);
}

function serializeAttachments(message) {
  if (!message?.attachments) return [];

  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    name: attachment.name || 'attachment',
    url: attachment.url || null,
    proxyURL: attachment.proxyURL || null,
    contentType: attachment.contentType || null,
    size: attachment.size || null,
    width: attachment.width || null,
    height: attachment.height || null,
  }));
}

function serializeEmbeds(message) {
  if (!Array.isArray(message?.embeds)) return [];

  return message.embeds.map((embed) => ({
    title: embed.title || null,
    description: embed.description || null,
    url: embed.url || null,
    color: embed.color || null,
    fields: Array.isArray(embed.fields)
      ? embed.fields.map((field) => ({
          name: field.name || '',
          value: field.value || '',
          inline: Boolean(field.inline),
        }))
      : [],
    footer: embed.footer?.text || null,
    author: embed.author?.name || null,
    image: embed.image?.url || null,
    thumbnail: embed.thumbnail?.url || null,
  }));
}

function serializeStickers(message) {
  if (!message?.stickers) return [];

  return [...message.stickers.values()].map((sticker) => ({
    id: sticker.id,
    name: sticker.name || 'sticker',
    url: sticker.url || null,
  }));
}

function serializeMessage(message) {
  return {
    guildId: String(message.guildId),
    channelId: String(message.channelId),
    messageId: String(message.id),
    authorId: String(message.author?.id || 'unknown'),
    authorUsername: message.author?.username || 'Unknown User',
    authorGlobalName: message.author?.globalName || null,
    authorBot: Boolean(message.author?.bot),
    authorAvatarURL:
      typeof message.author?.displayAvatarURL === 'function'
        ? message.author.displayAvatarURL({ size: 128 })
        : null,
    memberDisplayName: message.member?.displayName || null,
    content: message.content || '',
    createdTimestamp:
      Number(message.createdTimestamp) || Date.now(),
    editedTimestamp:
      Number(message.editedTimestamp) || null,
    attachments: serializeAttachments(message),
    embeds: serializeEmbeds(message),
    stickers: serializeStickers(message),
    referenceMessageId: message.reference?.messageId || null,
  };
}

async function resolveReportStaffState(channelId) {
  const state = await getTicketState(channelId).catch((error) => {
    console.error('[REPORT STAFF TRACKER STATE ERROR]', error);
    return null;
  });

  return state?.typeKey === 'report_staff' ? state : null;
}

async function upsertArchiveMetadata(channel, state) {
  if (!channel?.guild) return;

  const now = new Date();

  await (await archiveCollection()).updateOne(
    { _id: String(channel.id) },
    {
      $set: {
        guildId: String(channel.guild.id),
        channelId: String(channel.id),
        channelName: channel.name || `report-staff-${state?.number ?? 'unknown'}`,
        ticketNumber: state?.number ?? null,
        creatorId: state?.creatorId || null,
        reportedStaffId: state?.reportedStaffId || null,
        staffSelectionStatus: state?.staffSelectionStatus || null,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

async function ensureReportStaffArchive(channel) {
  if (!isReportStaffChannel(channel)) return false;

  const state = await resolveReportStaffState(channel.id);

  // ChannelCreate can fire before ticket-system has written the ticket state.
  // The topic itself still proves this is a Report Staff ticket, so create the
  // archive metadata even if state arrives a fraction later.
  await upsertArchiveMetadata(channel, state);
  return true;
}

async function recordMessage(message) {
  if (!message?.guild || !isReportStaffChannel(message.channel)) return;

  const state = await resolveReportStaffState(message.channelId);
  const snapshot = serializeMessage(message);
  const now = new Date();

  await upsertArchiveMetadata(message.channel, state);

  await (await messageCollection()).updateOne(
    {
      _id: `${snapshot.channelId}:${snapshot.messageId}`,
    },
    {
      $set: {
        ...snapshot,
        deletedAt: null,
        lastTrackedAt: now,
      },
      $setOnInsert: {
        firstTrackedAt: now,
        revisions: [],
      },
    },
    { upsert: true },
  );

}

async function recordMessageUpdate(oldMessage, newMessage) {
  const message = newMessage?.partial
    ? await newMessage.fetch().catch(() => newMessage)
    : newMessage;

  if (!message?.guild || !isReportStaffChannel(message.channel)) return;

  const collection = await messageCollection();
  const id = `${message.channelId}:${message.id}`;
  const existing = await collection.findOne({ _id: id });
  const snapshot = serializeMessage(message);
  const now = new Date();

  const update = {
    $set: {
      ...snapshot,
      deletedAt: existing?.deletedAt || null,
      lastTrackedAt: now,
    },
    $setOnInsert: {
      firstTrackedAt: now,
      revisions: [],
    },
  };

  if (
    existing &&
    typeof existing.content === 'string' &&
    existing.content !== snapshot.content
  ) {
    update.$push = {
      revisions: {
        content: existing.content,
        attachments: existing.attachments || [],
        embeds: existing.embeds || [],
        savedAt: now,
      },
    };
  }

  const state = await resolveReportStaffState(message.channelId);
  await upsertArchiveMetadata(message.channel, state);
  await collection.updateOne({ _id: id }, update, { upsert: true });
}

async function markMessageDeleted(message) {
  const channelId = message?.channelId || message?.channel?.id;
  const messageId = message?.id;

  if (!channelId || !messageId) return;

  const archive = await (await archiveCollection()).findOne({
    _id: String(channelId),
  });

  if (!archive && !isReportStaffChannel(message.channel)) return;

  const now = new Date();
  const collection = await messageCollection();
  const id = `${channelId}:${messageId}`;

  const existing = await collection.findOne({ _id: id });

  if (existing) {
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          deletedAt: now,
          lastTrackedAt: now,
        },
      },
    );
    return;
  }

  // If Discord supplied enough information for a deleted uncached message,
  // preserve whatever data is still available.
  if (message.author) {
    const snapshot = serializeMessage(message);
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          ...snapshot,
          deletedAt: now,
          lastTrackedAt: now,
        },
        $setOnInsert: {
          firstTrackedAt: now,
          revisions: [],
        },
      },
      { upsert: true },
    );
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp) || timestamp || Date.now());
  return Number.isNaN(date.getTime())
    ? 'Unknown time'
    : date.toLocaleString('en-GB', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }) + ' UTC';
}

function renderAttachments(attachments = []) {
  if (!attachments.length) return '';

  return attachments
    .map((attachment) => {
      const name = escapeHtml(attachment.name || 'attachment');
      const url = escapeHtml(attachment.url || attachment.proxyURL || '#');
      const isImage =
        String(attachment.contentType || '').startsWith('image/') ||
        /\.(png|jpe?g|gif|webp)$/i.test(String(attachment.name || ''));

      return `
        <div class="attachment">
          <a href="${url}" target="_blank" rel="noreferrer">${name}</a>
          ${
            isImage && url !== '#'
              ? `<div><img src="${url}" alt="${name}" loading="lazy"></div>`
              : ''
          }
        </div>
      `;
    })
    .join('');
}

function renderEmbeds(embeds = []) {
  if (!embeds.length) return '';

  return embeds
    .map((embed) => {
      const fields = (embed.fields || [])
        .map(
          (field) => `
            <div class="embed-field">
              <strong>${escapeHtml(field.name)}</strong>
              <div>${escapeHtml(field.value).replaceAll('\n', '<br>')}</div>
            </div>
          `,
        )
        .join('');

      return `
        <div class="discord-embed">
          ${embed.author ? `<div class="embed-author">${escapeHtml(embed.author)}</div>` : ''}
          ${
            embed.title
              ? `<div class="embed-title">${
                  embed.url
                    ? `<a href="${escapeHtml(embed.url)}" target="_blank">${escapeHtml(embed.title)}</a>`
                    : escapeHtml(embed.title)
                }</div>`
              : ''
          }
          ${
            embed.description
              ? `<div class="embed-description">${escapeHtml(embed.description).replaceAll('\n', '<br>')}</div>`
              : ''
          }
          ${fields}
          ${embed.image ? `<img class="embed-image" src="${escapeHtml(embed.image)}" loading="lazy">` : ''}
          ${embed.footer ? `<div class="embed-footer">${escapeHtml(embed.footer)}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderRevisions(revisions = []) {
  if (!revisions.length) return '';

  return `
    <details class="revisions">
      <summary>${revisions.length} earlier version${revisions.length === 1 ? '' : 's'}</summary>
      ${revisions
        .map(
          (revision) => `
            <div class="revision">
              <div class="muted">${escapeHtml(formatDate(revision.savedAt))}</div>
              <div>${escapeHtml(revision.content || '').replaceAll('\n', '<br>') || '<em>No text</em>'}</div>
            </div>
          `,
        )
        .join('')}
    </details>
  `;
}

function buildPersistentTranscriptHtml(meta, messages, deletedBy) {
  const rows = messages
    .map((message) => {
      const displayName =
        message.memberDisplayName ||
        message.authorGlobalName ||
        message.authorUsername ||
        'Unknown User';
      const avatar =
        message.authorAvatarURL ||
        'https://cdn.discordapp.com/embed/avatars/0.png';

      return `
        <article class="message ${message.deletedAt ? 'deleted-message' : ''}">
          <img class="avatar" src="${escapeHtml(avatar)}" alt="">
          <div class="message-main">
            <div class="message-header">
              <span class="author">${escapeHtml(displayName)}</span>
              <span class="username">@${escapeHtml(message.authorUsername || 'unknown')}</span>
              ${message.authorBot ? '<span class="bot">BOT</span>' : ''}
              <span class="timestamp">${escapeHtml(formatDate(message.createdTimestamp))}</span>
              ${message.editedTimestamp ? '<span class="muted">(edited)</span>' : ''}
              ${message.deletedAt ? '<span class="deleted-badge">DELETED AFTER LOGGING</span>' : ''}
            </div>
            ${
              message.content
                ? `<div class="content">${escapeHtml(message.content).replaceAll('\n', '<br>')}</div>`
                : ''
            }
            ${renderAttachments(message.attachments)}
            ${renderEmbeds(message.embeds)}
            ${renderRevisions(message.revisions)}
          </div>
        </article>
      `;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report Staff Ticket #${escapeHtml(meta.ticketNumber ?? 'Unknown')}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#313338;color:#dbdee1;font-family:Arial,Helvetica,sans-serif}
  .top{background:#1e1f22;padding:20px 24px;border-bottom:1px solid #111214;position:sticky;top:0;z-index:2}
  .top h1{font-size:20px;margin:0 0 8px;color:#f2f3f5}
  .meta{font-size:13px;line-height:1.65;color:#b5bac1}
  .meta strong{color:#f2f3f5}
  .wrap{max-width:1100px;margin:auto;padding:18px 12px 40px}
  .message{display:flex;gap:14px;padding:10px 12px;border-radius:6px}
  .message:hover{background:#2e3035}
  .deleted-message{border-left:3px solid #ed4245;background:rgba(237,66,69,.06)}
  .avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:0 0 40px}
  .message-main{min-width:0;flex:1}
  .message-header{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .author{font-weight:700;color:#f2f3f5}
  .username,.timestamp,.muted{font-size:12px;color:#949ba4}
  .bot{font-size:10px;font-weight:700;background:#5865f2;color:white;padding:1px 4px;border-radius:3px}
  .deleted-badge{font-size:10px;font-weight:700;color:#fff;background:#ed4245;padding:2px 5px;border-radius:3px}
  .content{white-space:normal;overflow-wrap:anywhere;line-height:1.42;margin-top:2px}
  .attachment{margin-top:8px}
  a{color:#00a8fc;text-decoration:none}
  .attachment img,.embed-image{max-width:min(520px,100%);max-height:420px;border-radius:6px;margin-top:6px}
  .discord-embed{max-width:560px;border-left:4px solid #4e5058;background:#2b2d31;border-radius:4px;padding:10px 12px;margin-top:7px}
  .embed-author{font-size:12px;font-weight:700;margin-bottom:5px}
  .embed-title{font-weight:700;margin-bottom:5px}
  .embed-description{line-height:1.4}
  .embed-field{margin-top:8px}
  .embed-footer{font-size:11px;color:#b5bac1;margin-top:8px}
  .revisions{margin-top:7px;color:#b5bac1;font-size:12px}
  .revision{padding:6px 8px;margin-top:5px;border-left:2px solid #4e5058;background:#2b2d31}
  .empty{text-align:center;color:#949ba4;padding:50px 10px}
</style>
</head>
<body>
<header class="top">
  <h1>🛡️ Persistent Report Staff Transcript</h1>
  <div class="meta">
    <div><strong>Ticket:</strong> #${escapeHtml(meta.ticketNumber ?? 'Unknown')} • ${escapeHtml(meta.channelName || meta.channelId)}</div>
    <div><strong>Ticket owner:</strong> ${escapeHtml(meta.creatorId || 'Unknown')}</div>
    <div><strong>Reported staff:</strong> ${escapeHtml(meta.reportedStaffId || 'Not selected')}</div>
    <div><strong>Channel ID:</strong> ${escapeHtml(meta.channelId)}</div>
    <div><strong>Deleted by:</strong> ${escapeHtml(deletedBy?.label || 'Unknown')}</div>
    <div><strong>Messages preserved:</strong> ${messages.length}</div>
    <div><strong>Transcript generated:</strong> ${escapeHtml(formatDate(Date.now()))}</div>
  </div>
</header>
<main class="wrap">
  ${rows || '<div class="empty">No messages were recorded for this ticket.</div>'}
</main>
</body>
</html>`;
}

async function resolveChannelDeleter(channel) {
  try {
    // Audit-log entries can take a moment to become visible after deletion.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const logs = await channel.guild.fetchAuditLogs({
      type: AuditLogEvent.ChannelDelete,
      limit: 6,
    });

    const entry = logs.entries.find(
      (candidate) =>
        candidate.target?.id === channel.id &&
        Date.now() - candidate.createdTimestamp < 15000,
    );

    if (!entry?.executor) {
      return {
        id: null,
        label: 'Unknown (audit log entry not available)',
      };
    }

    return {
      id: entry.executor.id,
      label: `${entry.executor.username} (${entry.executor.id})`,
    };
  } catch (error) {
    console.error('[REPORT STAFF DELETE AUDIT LOG ERROR]', error);
    return {
      id: null,
      label: 'Unknown (bot could not read audit logs)',
    };
  }
}

async function sendPersistentDeleteTranscript(channel, meta, messages) {
  const securityRecipient = await channel.client.users
    .fetch(REPORT_STAFF_SECURITY_USER_ID)
    .catch(() => null);

  if (!securityRecipient || typeof securityRecipient.send !== 'function') {
    throw new Error(
      `Could not fetch Report Staff security DM recipient ${REPORT_STAFF_SECURITY_USER_ID}.`,
    );
  }

  const deletedBy = await resolveChannelDeleter(channel);
  const html = buildPersistentTranscriptHtml(meta, messages, deletedBy);
  const filename = `report-staff-${meta.ticketNumber || channel.id}-persistent-transcript.html`;

  const securityEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🚨 Report Staff Ticket Deleted')
    .setDescription(
      'A **Report Staff** ticket channel was deleted. Its continuously tracked transcript was recovered from MongoDB.',
    )
    .addFields(
      {
        name: 'Ticket',
        value: meta.ticketNumber
          ? `#${meta.ticketNumber} • ${meta.channelName || channel.name}`
          : meta.channelName || channel.name,
      },
      {
        name: 'Ticket Owner',
        value: meta.creatorId ? `<@${meta.creatorId}>` : 'Unknown',
        inline: true,
      },
      {
        name: 'Reported Staff',
        value: meta.reportedStaffId
          ? `<@${meta.reportedStaffId}>`
          : 'Not selected',
        inline: true,
      },
      {
        name: 'Deleted By',
        value: deletedBy.id
          ? `<@${deletedBy.id}> (${deletedBy.id})`
          : deletedBy.label,
      },
      {
        name: 'Messages Preserved',
        value: String(messages.length),
        inline: true,
      },
      {
        name: 'Tracking Source',
        value: 'MongoDB persistent message archive',
        inline: true,
      },
      {
        name: 'CC Status',
        value: meta.creatorId
          ? `Pending delivery to <@${meta.creatorId}>`
          : 'No ticket creator found',
      },
    )
    .setTimestamp();

  async function sendTranscriptDm(recipient, embed) {
    const dmMessage = await recipient.send({
      files: [
        new AttachmentBuilder(Buffer.from(html, 'utf8'), {
          name: filename,
        }),
      ],
      embeds: [embed],
      allowedMentions: { parse: [] },
    });

    const attachment = dmMessage.attachments.first();

    if (attachment?.url) {
      await dmMessage.edit({
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Direct Link')
              .setEmoji('📎')
              .setStyle(ButtonStyle.Link)
              .setURL(attachment.url),
          ),
        ],
      });
    }

    return dmMessage;
  }

  // Primary security copy.
  const securityMessage = await sendTranscriptDm(
    securityRecipient,
    securityEmbed,
  );

  let creatorMessage = null;
  let creatorDmError = null;

  // Give the ticket creator their own backup copy as well. If the creator is
  // the same account as the security recipient, don't send a duplicate DM.
  if (
    meta.creatorId &&
    String(meta.creatorId) !== String(REPORT_STAFF_SECURITY_USER_ID)
  ) {
    const creatorRecipient = await channel.client.users
      .fetch(String(meta.creatorId))
      .catch(() => null);

    if (creatorRecipient && typeof creatorRecipient.send === 'function') {
      const creatorEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📑 Your Report Staff Ticket Backup')
        .setDescription(
          'Your **Report Staff** ticket was deleted. Here is a backup copy of the continuously tracked transcript.',
        )
        .addFields(
          {
            name: 'Ticket',
            value: meta.ticketNumber
              ? `#${meta.ticketNumber} • ${meta.channelName || channel.name}`
              : meta.channelName || channel.name,
          },
          {
            name: 'Messages Preserved',
            value: String(messages.length),
            inline: true,
          },
          {
            name: 'Deleted By',
            value: deletedBy.id
              ? `<@${deletedBy.id}>`
              : deletedBy.label,
            inline: true,
          },
        )
        .setFooter({
          text: 'Keep this transcript as a backup of your staff report.',
        })
        .setTimestamp();

      try {
        creatorMessage = await sendTranscriptDm(
          creatorRecipient,
          creatorEmbed,
        );

        console.log(
          `[REPORT STAFF CREATOR BACKUP] Transcript for ticket ` +
            `${meta.ticketNumber ?? channel.id} sent to creator ${meta.creatorId}.`,
        );
      } catch (error) {
        creatorDmError = error;
        console.error('[REPORT STAFF CREATOR BACKUP DM ERROR]', error);
      }
    } else {
      creatorDmError = new Error(
        `Could not fetch ticket creator ${meta.creatorId} for transcript DM.`,
      );
      console.error(
        '[REPORT STAFF CREATOR BACKUP DM ERROR]',
        creatorDmError,
      );
    }
  }

  // Update the security/admin copy with the final CC delivery status.
  // This makes the DM sent to the security recipient clearly show whether the
  // ticket creator also received their backup.
  try {
    const ccStatus =
      String(meta.creatorId || '') === String(REPORT_STAFF_SECURITY_USER_ID)
        ? `Sent to CC <@${meta.creatorId}> (same recipient)`
        : creatorMessage
          ? `Sent to CC <@${meta.creatorId}>`
          : meta.creatorId
            ? `❌ Failed to send CC to <@${meta.creatorId}>`
            : 'No ticket creator found';

    const updatedSecurityEmbed = EmbedBuilder.from(securityEmbed);

    const fields = updatedSecurityEmbed.data.fields || [];
    const ccFieldIndex = fields.findIndex((field) => field.name === 'CC Status');

    if (ccFieldIndex >= 0) {
      fields[ccFieldIndex] = {
        name: 'CC Status',
        value: ccStatus,
      };
      updatedSecurityEmbed.setFields(fields);
    } else {
      updatedSecurityEmbed.addFields({
        name: 'CC Status',
        value: ccStatus,
      });
    }

    await securityMessage.edit({
      embeds: [updatedSecurityEmbed],
      components: securityMessage.components,
    });
  } catch (error) {
    console.error('[REPORT STAFF SECURITY CC STATUS UPDATE ERROR]', error);
  }

  return {
    logMessage: securityMessage,
    securityMessage,
    creatorMessage,
    creatorDmError,
    deletedBy,
    filename,
  };
}

async function trackReportStaffChannelCreate(channel) {
  if (!isReportStaffChannel(channel)) return;

  return queueChannelWrite(channel.id, async () => {
    // Ticket state is written just after the Discord channel is created.
    // Retry briefly so metadata such as creator/reported staff is present even
    // when Discord's ChannelCreate event arrives first.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await ensureReportStaffArchive(channel);

      const state = await resolveReportStaffState(channel.id);
      if (state) {
        console.log(
          `[REPORT STAFF TRACKER] Registered ${channel.name} (${channel.id}) ` +
            `on attempt ${attempt}.`,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    // Even if Mongo ticket-state lookup is delayed, the archive metadata has
    // already been created using the category/topic detection.
    console.log(
      `[REPORT STAFF TRACKER] Registered ${channel.name} (${channel.id}) ` +
        'without ticket state; message tracking is still active.',
    );
  });
}

function trackReportStaffMessageCreate(message) {
  if (!message?.guild || !isReportStaffChannel(message.channel)) {
    return Promise.resolve();
  }

  return queueChannelWrite(message.channelId, () => recordMessage(message));
}

function trackReportStaffMessageUpdate(oldMessage, newMessage) {
  const channel = newMessage?.channel || oldMessage?.channel;

  if (!channel?.guild || !isReportStaffChannel(channel)) {
    return Promise.resolve();
  }

  return queueChannelWrite(channel.id, () =>
    recordMessageUpdate(oldMessage, newMessage),
  );
}

function trackReportStaffMessageDelete(message) {
  const channelId = message?.channelId || message?.channel?.id;
  if (!channelId) return Promise.resolve();

  return queueChannelWrite(channelId, () => markMessageDeleted(message));
}

async function trackReportStaffMessageDeleteBulk(messages) {
  const grouped = new Map();

  for (const message of messages.values()) {
    const channelId = message.channelId || message.channel?.id;
    if (!channelId) continue;

    if (!grouped.has(channelId)) grouped.set(channelId, []);
    grouped.get(channelId).push(message);
  }

  await Promise.all(
    [...grouped.entries()].map(([channelId, channelMessages]) =>
      queueChannelWrite(channelId, async () => {
        for (const message of channelMessages) {
          await markMessageDeleted(message);
        }
      }),
    ),
  );
}

async function fetchAllChannelMessagesForBackfill(channel) {
  const all = [];
  let before;

  for (;;) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
      cache: false,
    });

    if (!batch.size) break;

    all.push(...batch.values());
    before = batch.last().id;

    if (batch.size < 100) break;
  }

  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function backfillReportStaffChannel(channel) {
  if (!isReportStaffChannel(channel)) return;

  await queueChannelWrite(channel.id, async () => {
    await ensureReportStaffArchive(channel);

    const messages = await fetchAllChannelMessagesForBackfill(channel);

    for (const message of messages) {
      await recordMessage(message);
    }

    console.log(
      `[REPORT STAFF BACKFILL] ${channel.name} (${channel.id}): ` +
        `${messages.length} message(s) copied to MongoDB.`,
    );
  });
}

async function backfillOpenReportStaffTickets(client) {
  let channelsFound = 0;

  for (const guild of client.guilds.cache.values()) {
    const channels = [...guild.channels.cache.values()].filter(
      (channel) =>
        channel.isTextBased?.() &&
        isReportStaffChannel(channel),
    );

    for (const channel of channels) {
      channelsFound += 1;
      try {
        await backfillReportStaffChannel(channel);
      } catch (error) {
        console.error(
          `[REPORT STAFF BACKFILL CHANNEL ERROR] ${channel.id}`,
          error,
        );
      }
    }
  }

  console.log(
    `[REPORT STAFF BACKFILL] Finished. ${channelsFound} open Report Staff ticket(s) scanned.`,
  );
}

async function handleReportStaffChannelDelete(channel) {
  if (!channel?.guild) return;

  console.log(
    `[REPORT STAFF DELETE EVENT] channel=${channel.id} name=${channel.name} ` +
      `parent=${channel.parentId || 'none'} reportStaff=${isReportStaffChannel(channel)}`,
  );

  if (!isReportStaffChannel(channel)) {
    return;
  }

  // Finish any message writes that were already queued before the channel
  // deletion event arrived.
  await waitForPendingChannelWrites(channel.id);

  // Give MessageCreate/Update listeners from the same event-loop burst a brief
  // chance to enqueue their MongoDB writes before reading the final archive.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForPendingChannelWrites(channel.id);

  const archives = await archiveCollection();
  let meta = await archives.findOne({ _id: String(channel.id) });

  // If the archive metadata somehow has not been created yet but the deleted
  // channel topic proves it was Report Staff, recover metadata from ticket state.
  if (!meta) {
    const state = await resolveReportStaffState(channel.id);

    meta = {
      _id: String(channel.id),
      guildId: String(channel.guild.id),
      channelId: String(channel.id),
      channelName: channel.name,
      ticketNumber: state?.number ?? null,
      creatorId: state?.creatorId || null,
      reportedStaffId: state?.reportedStaffId || null,
      staffSelectionStatus: state?.staffSelectionStatus || null,
    };
  }

  if (!meta) return;

  const messages = await (await messageCollection())
    .find({ channelId: String(channel.id) })
    .sort({ createdTimestamp: 1, messageId: 1 })
    .toArray();

  try {
    const result = await sendPersistentDeleteTranscript(
      channel,
      meta,
      messages,
    );

    await archives.updateOne(
      { _id: String(channel.id) },
      {
        $set: {
          channelName: channel.name || meta.channelName,
          deletedAt: new Date(),
          deleteTranscriptSentAt: new Date(),
          deleteTranscriptMessageId: result.logMessage.id,
          creatorBackupTranscriptMessageId: result.creatorMessage?.id || null,
          creatorBackupDmError: result.creatorDmError
            ? String(result.creatorDmError?.message || result.creatorDmError)
            : null,
          deletedById: result.deletedBy.id,
          deletedByLabel: result.deletedBy.label,
          preservedMessageCount: messages.length,
        },
      },
      { upsert: true },
    );

    console.log(
      `[REPORT STAFF DELETE ARCHIVE] Ticket ${meta.ticketNumber ?? channel.id} ` +
        `deleted; ${messages.length} tracked message(s) sent to security user ` +
        `${REPORT_STAFF_SECURITY_USER_ID}` +
        `${result.creatorMessage ? ` and creator ${meta.creatorId}` : ''}.`,
    );
  } catch (error) {
    // The Discord channel is already gone, but the MongoDB archive remains, so
    // the transcript data itself is NOT lost even if sending the security DM
    // temporarily fails (for example, if the recipient has DMs disabled).
    await archives.updateOne(
      { _id: String(channel.id) },
      {
        $set: {
          channelName: channel.name || meta.channelName,
          deletedAt: new Date(),
          deleteTranscriptSendError: String(error?.message || error),
        },
      },
      { upsert: true },
    );

    throw error;
  }
}

module.exports = {
  backfillOpenReportStaffTickets,
  trackReportStaffChannelCreate,
  trackReportStaffMessageCreate,
  trackReportStaffMessageUpdate,
  trackReportStaffMessageDelete,
  trackReportStaffMessageDeleteBulk,
  handleReportStaffChannelDelete,
};
