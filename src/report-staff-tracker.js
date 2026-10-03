const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { getMongoDb } = require('./database');
const { getTicketState } = require('./ticket-store');
const { gzipSync } = require('node:zlib');
const { resolveTicketDeleter } = require('./ticket-deletion-audit');
const { signAndStoreTranscript, TRANSCRIPT_INTEGRITY_SLOT } = require('./transcript-integrity');
const TRANSCRIPT_LOG_CHANNEL_ID = '1538580589542777055';

// This is a USER ID, not a guild channel ID.
// Manual-deletion transcripts are sent directly to this user's DMs.
const REPORT_STAFF_SECURITY_USER_ID =
  process.env.REPORT_STAFF_SECURITY_USER_ID || '1150135578378125383';

const ARCHIVE_COLLECTION = 'report_staff_archives';
const MESSAGE_COLLECTION = 'report_staff_messages';

const pendingChannelWrites = new Map();
const pendingDeletionJobs = new Map();
const trackedChannelIds = new Set();

function ticketTopicData(channel) {
  if (!channel?.guild || typeof channel.topic !== 'string') return null;
  const number = channel.topic.match(/Ticket #(\d+)/i);
  const creator = channel.topic.match(/Created by <@!?(\d+)>/i);
  const type = channel.topic.match(/(?:^|\|)\s*Type=([a-z_]+)/i);
  if (!number || !creator) return null;
  return { number: Number(number[1]), creatorId: creator[1], typeKey: type?.[1] || 'bug_report' };
}

function isTicketChannel(channel) {
  return Boolean(ticketTopicData(channel));
}

function isReportStaffChannel(channel) {
  return ticketTopicData(channel)?.typeKey === 'report_staff';
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
    memberDisplayHexColor: message.member?.displayHexColor || null,
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

  return state || null;
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
        channelName: channel.name || `ticket-${state?.number ?? 'unknown'}`,
        ticketType: state?.typeKey || ticketTopicData(channel)?.typeKey,
        closedById: state?.closedById || null,
        closedAt: state?.closedAt || null,
        claimHistory: state?.claimHistory || [],
        assistHistory: state?.assistHistory || [],
        handoverHistory: state?.handoverHistory || [],
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
  if (!isTicketChannel(channel)) return false;
  trackedChannelIds.add(String(channel.id));

  const state = await resolveReportStaffState(channel.id) || ticketTopicData(channel);

  // ChannelCreate can fire before ticket-system has written the ticket state.
  // The topic itself still proves this is a ticket, so create the
  // archive metadata even if state arrives a fraction later.
  await upsertArchiveMetadata(channel, state);
  return true;
}

async function recordMessage(message) {
  if (!message?.guild || !isTicketChannel(message.channel)) return;

  const state = await resolveReportStaffState(message.channelId) || ticketTopicData(message.channel);
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

  if (!message?.guild || !isTicketChannel(message.channel)) return;

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
    delete update.$setOnInsert.revisions; // MongoDB cannot $push and $setOnInsert the same path.
    update.$push = {
      revisions: {
        content: existing.content,
        attachments: existing.attachments || [],
        embeds: existing.embeds || [],
        savedAt: now,
      },
    };
  }

  const state = await resolveReportStaffState(message.channelId) || ticketTopicData(message.channel);
  await upsertArchiveMetadata(message.channel, state);
  await collection.updateOne({ _id: id }, update, { upsert: true });
}

async function markMessageDeleted(message) {
  const channelId = message?.channelId || message?.channel?.id;
  const messageId = message?.id;

  if (!channelId || !messageId) return;

  if (!isTicketChannel(message.channel) && !trackedChannelIds.has(String(channelId))) return;

  const archive = await (await archiveCollection()).findOne({
    _id: String(channelId),
  });

  if (!archive && !isTicketChannel(message.channel)) return;

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
  const messageById = new Map(messages.map(message => [message.messageId, message]));
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

      const repliedTo = messageById.get(message.referenceMessageId);
      const reply = message.referenceMessageId
        ? `<div class="muted">↪ Reply to ${escapeHtml(repliedTo?.memberDisplayName || repliedTo?.authorUsername || 'unavailable message')}: ${escapeHtml((repliedTo?.content || '').slice(0, 200))}</div>`
        : '';
      const authorColor = /^#[a-f0-9]{6}$/i.test(message.memberDisplayHexColor || '') && message.memberDisplayHexColor !== '#000000'
        ? message.memberDisplayHexColor : '#f2f3f5';
      return `
        <article class="message ${message.deletedAt ? 'deleted-message' : ''}">
          <img class="avatar" src="${escapeHtml(avatar)}" alt="">
          <div class="message-main">
            <div class="message-header">
              <span class="author" style="color:${authorColor}">${escapeHtml(displayName)}</span>
              <span class="username">@${escapeHtml(message.authorUsername || 'unknown')}</span>
              ${message.authorBot ? '<span class="bot">BOT</span>' : ''}
              <span class="timestamp">${escapeHtml(formatDate(message.createdTimestamp))}</span>
              ${message.editedTimestamp ? '<span class="muted">(edited)</span>' : ''}
              ${message.deletedAt ? '<span class="deleted-badge">DELETED AFTER LOGGING</span>' : ''}
            </div>
            ${reply}
            ${
              message.content
                ? `<div class="content">${escapeHtml(message.content).replaceAll('\n', '<br>')}</div>`
                : ''
            }
            ${renderAttachments(message.attachments)}
            ${renderEmbeds(message.embeds)}
            ${(message.stickers || []).map(sticker => sticker.url ? `<div class="attachment"><img src="${escapeHtml(sticker.url)}" alt="${escapeHtml(sticker.name)}"></div>` : '').join('')}
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
<title>Ticket #${escapeHtml(meta.ticketNumber ?? 'Unknown')}</title>
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
  <h1>📑 Ticket Transcript</h1>
  <div class="meta">
    <div><strong>Ticket:</strong> #${escapeHtml(meta.ticketNumber ?? 'Unknown')} • ${escapeHtml(meta.channelName || meta.channelId)}</div>
    <div><strong>Ticket owner:</strong> ${escapeHtml(meta.creatorId || 'Unknown')}</div>
    <div><strong>Reported staff:</strong> ${escapeHtml(meta.reportedStaffId || 'Not selected')}</div>
    <div><strong>Channel ID:</strong> ${escapeHtml(meta.channelId)}</div>
    <div><strong>Deleted by:</strong> ${escapeHtml(deletedBy?.label || 'Unknown')}</div>
    <div><strong>Deletion method:</strong> ${escapeHtml(deletedBy?.method || 'Unknown')}</div>
    <div><strong>Deleted at:</strong> ${escapeHtml(formatDate(deletedBy?.deletedAt))}</div>
    <div><strong>Closed by:</strong> ${escapeHtml(meta.closedById || 'Unknown')} • ${escapeHtml(meta.closedAt ? formatDate(meta.closedAt) : 'Not recorded')}</div>
    <div><strong>Ticket type:</strong> ${escapeHtml(meta.ticketType || 'Unknown')}</div>
    <div><strong>Ownership history:</strong> ${escapeHtml(JSON.stringify(meta.claimHistory || []))}</div>
    <div><strong>Assist history:</strong> ${escapeHtml(JSON.stringify(meta.assistHistory || []))}</div>
    <div><strong>Handover history:</strong> ${escapeHtml(JSON.stringify(meta.handoverHistory || []))}</div>
    <div><strong>Messages preserved:</strong> ${messages.length}</div>
    <div><strong>Transcript generated:</strong> ${escapeHtml(formatDate(Date.now()))}</div>
  </div>
</header>
<main class="wrap">
  ${rows || '<div class="empty">No messages were recorded for this ticket.</div>'}
</main>
${TRANSCRIPT_INTEGRITY_SLOT}
</body>
</html>`;
}


async function signedPersistentTranscript(meta, messages, deletedBy) {
  return signAndStoreTranscript({
    canonicalHtml: buildPersistentTranscriptHtml(meta, messages, deletedBy),
    metadata: {
      guildId: meta.guildId, channelId: meta.channelId, channelName: meta.channelName,
      ticketNumber: meta.ticketNumber, ticketType: meta.ticketType, creatorId: meta.creatorId,
      closedById: meta.closedById || null, closedAt: meta.closedAt || null,
      deletedById: deletedBy.id, deletionMethod: deletedBy.method,
      deletionExecutorId: deletedBy.executorId, deletedAt: deletedBy.deletedAt,
      deletionAuditEntryId: deletedBy.auditEntryId, messageCount: messages.length,
      source: 'persistent_ticket_archive',
    },
  });
}

function transcriptFile(html, filename) {
  const buffer = Buffer.from(html, 'utf8');
  // Stay under the smallest common Discord attachment limit.
  const compressed = buffer.length > 7 * 1024 * 1024;
  return new AttachmentBuilder(compressed ? gzipSync(buffer) : buffer, {
    name: compressed ? `${filename}.gz` : filename,
  });
}

async function sendNormalDeleteTranscript(channel, meta, messages, deletedBy) {
  const logChannel = channel.guild.channels.cache.get(TRANSCRIPT_LOG_CHANNEL_ID) ||
    await channel.guild.channels.fetch(TRANSCRIPT_LOG_CHANNEL_ID);
  if (!logChannel?.isTextBased?.() || typeof logChannel.send !== 'function') {
    throw new Error('Ticket transcript log channel is unavailable.');
  }
  const artifact = await signedPersistentTranscript(meta, messages, deletedBy);
  const filename = `ticket-${meta.ticketNumber || channel.id}-${artifact.integrity.transcriptId}.html`;
  const embed = new EmbedBuilder().setColor(0xed4245).setTitle('Ticket Deleted — Final Transcript')
    .setDescription(`#${meta.ticketNumber || channel.id} • ${meta.channelName || channel.name}`)
    .addFields(
      { name: 'Ticket Owner', value: meta.creatorId ? `<@${meta.creatorId}> (${meta.creatorId})` : 'Unknown' },
      { name: 'Deleted By', value: deletedBy.id ? `<@${deletedBy.id}> (${deletedBy.id})` : deletedBy.label },
      { name: 'Deletion Method', value: deletedBy.method, inline: true },
      { name: 'Deleted At', value: deletedBy.deletedAt, inline: true },
      { name: 'Messages Preserved', value: String(messages.length), inline: true },
      { name: 'Integrity ID', value: artifact.integrity.transcriptId },
    ).setFooter({ text: 'Recovered from the persistent ticket archive • Times in UTC' }).setTimestamp();
  const logMessage = await logChannel.send({ files: [transcriptFile(artifact.html, filename)], embeds: [embed], allowedMentions: { parse: [] } });
  const attachment = logMessage.attachments.first();
  if (attachment?.url) {
    await logMessage.edit({ components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Direct Link').setStyle(ButtonStyle.Link).setURL(attachment.url),
    )] }).catch(error => console.warn('[TICKET TRANSCRIPT LINK EDIT WARNING]', error.message));
  }
  return { logMessage, creatorMessage: null, creatorDmError: null, deletedBy, filename };
}

async function sendPersistentDeleteTranscript(channel, meta, messages, deletedBy) {
  if (meta.ticketType !== 'report_staff') return sendNormalDeleteTranscript(channel, meta, messages, deletedBy);
  const securityRecipient = await channel.client.users
    .fetch(REPORT_STAFF_SECURITY_USER_ID)
    .catch(() => null);

  if (!securityRecipient || typeof securityRecipient.send !== 'function') {
    throw new Error(
      `Could not fetch Report Staff security DM recipient ${REPORT_STAFF_SECURITY_USER_ID}.`,
    );
  }

  const html = (await signedPersistentTranscript(meta, messages, deletedBy)).html;
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
      { name: 'Deletion Method', value: deletedBy.method },
      { name: 'Deleted At', value: deletedBy.deletedAt },
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
        transcriptFile(html, filename),
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
      }).catch(error => console.warn('[TICKET TRANSCRIPT LINK EDIT WARNING]', error.message));
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
          { name: 'Deletion Method', value: deletedBy.method },
          { name: 'Deleted At', value: deletedBy.deletedAt },
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
  if (!isTicketChannel(channel)) return;

  return queueChannelWrite(channel.id, async () => {
    // Ticket state is written just after the Discord channel is created.
    // Retry briefly so metadata such as creator/reported staff is present even
    // when Discord's ChannelCreate event arrives first.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await ensureReportStaffArchive(channel);

      const state = await resolveReportStaffState(channel.id);
      if (state) {
        console.log(
          `[TICKET ARCHIVE TRACKER] Registered ${channel.name} (${channel.id}) ` +
            `on attempt ${attempt}.`,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    // Even if Mongo ticket-state lookup is delayed, the archive metadata has
    // already been created using the category/topic detection.
    console.log(
      `[TICKET ARCHIVE TRACKER] Registered ${channel.name} (${channel.id}) ` +
        'without ticket state; message tracking is still active.',
    );
  });
}

function trackReportStaffMessageCreate(message) {
  if (!message?.guild || !isTicketChannel(message.channel)) {
    return Promise.resolve();
  }

  return queueChannelWrite(message.channelId, () => recordMessage(message));
}

function trackReportStaffMessageUpdate(oldMessage, newMessage) {
  const channel = newMessage?.channel || oldMessage?.channel;

  if (!channel?.guild || !isTicketChannel(channel)) {
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
  if (!isTicketChannel(channel)) return;

  await queueChannelWrite(channel.id, async () => {
    await ensureReportStaffArchive(channel);

    const messages = await fetchAllChannelMessagesForBackfill(channel);

    for (const message of messages) {
      await recordMessage(message);
    }

    console.log(
      `[TICKET ARCHIVE BACKFILL] ${channel.name} (${channel.id}): ` +
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
        isTicketChannel(channel),
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
    `[TICKET ARCHIVE BACKFILL] Finished. ${channelsFound} open ticket(s) scanned.`,
  );
}

async function archiveDeletedTicket(channel) {
  if (!channel?.guild || !isTicketChannel(channel)) return;
  const observedAt = Date.now();
  const deletion = resolveTicketDeleter(channel, observedAt);

  console.log(
    `[TICKET DELETE EVENT] channel=${channel.id} name=${channel.name} ` +
      `parent=${channel.parentId || 'none'} reportStaff=${isReportStaffChannel(channel)}`,
  );

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
  // channel topic proves it was a ticket, recover metadata from ticket state.
  if (!meta) {
    const state = await resolveReportStaffState(channel.id) || ticketTopicData(channel);

    meta = {
      _id: String(channel.id),
      guildId: String(channel.guild.id),
      channelId: String(channel.id),
      channelName: channel.name,
      ticketNumber: state?.number ?? null,
      ticketType: state?.typeKey || ticketTopicData(channel)?.typeKey,
      creatorId: state?.creatorId || null,
      reportedStaffId: state?.reportedStaffId || null,
      staffSelectionStatus: state?.staffSelectionStatus || null,
    };
  }

  if (!meta || meta.deleteTranscriptSentAt) return;
  const deletedBy = await deletion;
  const finalState = await resolveReportStaffState(channel.id);
  if (finalState) {
    meta = { ...meta, closedById: finalState.closedById, closedAt: finalState.closedAt, claimHistory: finalState.claimHistory, assistHistory: finalState.assistHistory, handoverHistory: finalState.handoverHistory };
  }
  meta = { ...meta, ticketType: meta.ticketType || ticketTopicData(channel)?.typeKey };
  // Persist the actor and complete metadata even when uploading fails.
  await archives.updateOne({ _id: String(channel.id) }, { $set: {
    guildId: meta.guildId, channelId: meta.channelId, channelName: meta.channelName,
    ticketNumber: meta.ticketNumber, ticketType: meta.ticketType, creatorId: meta.creatorId,
    closedById: meta.closedById || null, closedAt: meta.closedAt || null,
    claimHistory: meta.claimHistory || [], assistHistory: meta.assistHistory || [], handoverHistory: meta.handoverHistory || [],
    deletedById: deletedBy.id, deletedByLabel: deletedBy.label, deletionMethod: deletedBy.method,
    deletionExecutorId: deletedBy.executorId, deletionAuditEntryId: deletedBy.auditEntryId, deletedAt: new Date(deletedBy.deletedAt),
  } }, { upsert: true });

  const messages = await (await messageCollection())
    .find({ channelId: String(channel.id) })
    .sort({ createdTimestamp: 1, messageId: 1 })
    .toArray();

  try {
    const result = await sendPersistentDeleteTranscript(
      channel,
      meta,
      messages,
      deletedBy,
    );

    await archives.updateOne(
      { _id: String(channel.id) },
      {
        $set: {
          channelName: channel.name || meta.channelName,
          deletedAt: new Date(deletedBy.deletedAt),
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
          deletedAt: new Date(deletedBy.deletedAt),
          deleteTranscriptSendError: String(error?.message || error),
        },
      },
      { upsert: true },
    );

    throw error;
  }
}

function handleReportStaffChannelDelete(channel) {
  if (!channel?.guild || !isTicketChannel(channel)) return Promise.resolve();
  const key = String(channel.id);
  if (pendingDeletionJobs.has(key)) return pendingDeletionJobs.get(key);
  const job = archiveDeletedTicket(channel).finally(() => pendingDeletionJobs.delete(key));
  pendingDeletionJobs.set(key, job);
  return job;
}

module.exports = {
  backfillOpenReportStaffTickets,
  trackReportStaffChannelCreate,
  trackReportStaffMessageCreate,
  trackReportStaffMessageUpdate,
  trackReportStaffMessageDelete,
  trackReportStaffMessageDeleteBulk,
  handleReportStaffChannelDelete,
  isTicketChannel,
  backfillTicketBeforeDelete: backfillReportStaffChannel,
};
