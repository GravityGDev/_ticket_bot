
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { randomBytes } = require('node:crypto');
const { isBotDeveloper } = require('./staff-role-hierarchy');
const { getHangmanGame, saveHangmanGame, deleteHangmanGame } = require('./hangman-store');
const {
  MAX_MISSES,
  normalizeSecret,
  normalizeLetterGuess,
  normalizeWordGuess,
  maskWord,
  applyLetterGuess,
  applyWordGuess,
} = require('./hangman-logic');

const queues = new Map();
const COLORS = Object.freeze({
  active: 0x5865f2,
  won: 0x57f287,
  lost: 0xed4245,
  ended: 0xfee75c,
});
const STAGES = Object.freeze([
  ['  +-----+', '  |', '  |', '  |', '  |', '--+----'].join('\n'),
  ['  +-----+', '  |     O', '  |', '  |', '  |', '--+----'].join('\n'),
  ['  +-----+', '  |     O', '  |     |', '  |', '  |', '--+----'].join('\n'),
  ['  +-----+', '  |     O', '  |    /|', '  |', '  |', '--+----'].join('\n'),
  ['  +-----+', '  |     O', '  |    /|\\', '  |', '  |', '--+----'].join('\n'),
  ['  +-----+', '  |     O', '  |    /|\\', '  |    /', '  |', '--+----'].join('\n'),
  ['  +-----+', '  |     O', '  |    /|\\', '  |    / \\', '  |', '--+----'].join('\n'),
]);

function newGameId() {
  return randomBytes(6).toString('hex');
}

function cleanText(value, max = 100) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x60*_~>|]/g, '')
    .trim()
    .slice(0, max);
}

function isOpenDevTicket(channel) {
  return Boolean(
    channel &&
    /(?:^|\|)\s*Type=dev_test(?:\s*\||$)/i.test(String(channel.topic || '')) &&
    !String(channel.name || '').toLowerCase().startsWith('closed-')
  );
}

function lives(misses) {
  const used = Math.max(0, Math.min(MAX_MISSES, Number(misses) || 0));
  return '\u2764\uFE0F'.repeat(MAX_MISSES - used) + '\uD83D\uDDA4'.repeat(used);
}

function heading(game) {
  if (game.status === 'won') {
    return '## \uD83C\uDFC6 Hangman Complete\n<@' + game.winnerId + '> guessed the word!';
  }
  if (game.status === 'lost') {
    return '## \uD83D\uDC80 Hangman Over\nThe guessers ran out of chances.';
  }
  if (game.status === 'ended') {
    return '## \uD83D\uDED1 Hangman Ended\nThe developer ended this round.';
  }
  return '## \uD83C\uDFAF Snay.io Hangman\nHosted by <@' + game.hostId + '> \u2022 **Dev Ticket Game**';
}

function shownWord(game) {
  if (game.status === 'active') return maskWord(game.word, game.guessedLetters);
  return String(game.word || '')
    .split('')
    .map((character) => character === ' ' ? '/' : character)
    .join(' ');
}

function buildHangmanBoard(game) {
  const misses = Math.max(0, Math.min(MAX_MISSES, Number(game.misses) || 0));
  const guessed = Array.isArray(game.guessedLetters) ? [...game.guessedLetters].sort() : [];
  const wrongLetters = guessed.filter((letter) => !String(game.word || '').includes(letter));
  const wrongWords = Array.isArray(game.wrongWordGuesses) ? game.wrongWordGuesses.slice(-4) : [];
  const players = new Set((game.playerIds || []).map(String)).size;

  const container = new ContainerBuilder()
    .setAccentColor(COLORS[game.status] || COLORS.active)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(heading(game)),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('' + '\x60\x60\x60text\n' + STAGES[misses] + '\n\x60\x60\x60'),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('### \x60' + shownWord(game) + '\x60'),
    );

  if (game.hint) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('\uD83D\uDCA1 **Hint:** ' + cleanText(game.hint)),
    );
  }

  let stats =
    '**Chances:** ' + lives(misses) +
    ' \u2022 **Mistakes:** ' + misses + '/' + MAX_MISSES +
    ' \u2022 **Players:** ' + players + '\n' +
    '**Guessed letters:** ' + (guessed.length ? guessed.join(', ') : 'None yet') + '\n' +
    '**Wrong letters:** ' + (wrongLetters.length ? wrongLetters.join(', ') : 'None');

  if (wrongWords.length) {
    stats += '\n**Wrong word guesses:** ' +
      wrongWords.map((guess) => '\x60' + cleanText(guess, 40) + '\x60').join(', ');
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(stats));

  if (game.status === 'active') {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('hangman:letter:' + game.gameId)
            .setLabel('Guess Letter')
            .setEmoji('\uD83D\uDD24')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('hangman:word:' + game.gameId)
            .setLabel('Guess Word')
            .setEmoji('\uD83E\uDDE0')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('hangman:end:' + game.gameId)
            .setLabel('End Game \u2022 Dev')
            .setEmoji('\uD83D\uDED1')
            .setStyle(ButtonStyle.Danger),
        ),
      );
  } else {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '**Word:** \x60' + cleanText(game.word, 40) + '\x60\n-# Start another round with \x60/hangman\x60.',
        ),
      );
  }

  return container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('-# Snay.io \u2022 Hangman \u2022 Components V2'),
  );
}

function buildSetupModal(channelId) {
  const word = new TextInputBuilder()
    .setCustomId('hangman_word')
    .setLabel('Secret word or phrase')
    .setPlaceholder('Example: command systems')
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(40)
    .setRequired(true);

  const hint = new TextInputBuilder()
    .setCustomId('hangman_hint')
    .setLabel('Hint (optional)')
    .setPlaceholder('Give them a small clue...')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(false);

  return new ModalBuilder()
    .setCustomId('hangman:setup:' + channelId)
    .setTitle('Create Hangman Game')
    .addComponents(
      new ActionRowBuilder().addComponents(word),
      new ActionRowBuilder().addComponents(hint),
    );
}

function buildGuessModal(kind, id) {
  const isLetter = kind === 'letter';
  const input = new TextInputBuilder()
    .setCustomId('hangman_guess')
    .setLabel(isLetter ? 'Your letter' : 'Your word or phrase')
    .setPlaceholder(isLetter ? 'A' : 'Enter your full guess...')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(isLetter ? 1 : 40)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId('hangman:guess-' + kind + ':' + id)
    .setTitle(isLetter ? 'Hangman \u2022 Guess a Letter' : 'Hangman \u2022 Guess the Word')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function withLock(key, task) {
  const normalized = String(key);
  const previous = queues.get(normalized) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chain = previous.catch(() => {}).then(() => current);
  queues.set(normalized, chain);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (queues.get(normalized) === chain) queues.delete(normalized);
  }
}

async function openHangmanSetup(interaction) {
  if (!interaction.inGuild?.()) {
    return interaction.reply({
      content: 'Use \x60/hangman\x60 inside the server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isBotDeveloper(interaction.user)) {
    return interaction.reply({
      content: 'Only the bot developer can start Hangman.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isOpenDevTicket(interaction.channel)) {
    return interaction.reply({
      content: 'Hangman can only be started inside an **open Dev test ticket**.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const active = await getHangmanGame(
    interaction.guild.id,
    interaction.channel.id,
  ).catch(() => null);

  if (active?.status === 'active') {
    return interaction.reply({
      content: 'A Hangman round is already active here. Finish it or use **End Game \u2022 Dev** first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.showModal(buildSetupModal(interaction.channel.id));
}

async function getMatchingGame(interaction, id) {
  if (!interaction.guild || !interaction.channel) return null;
  const game = await getHangmanGame(interaction.guild.id, interaction.channel.id);
  return game && String(game.gameId) === String(id) ? game : null;
}

async function refreshBoard(interaction, game) {
  let message = null;

  if (
    interaction.message &&
    String(interaction.message.id) === String(game.messageId)
  ) {
    message = interaction.message;
  } else if (game.messageId) {
    message = await interaction.channel.messages.fetch(game.messageId).catch(() => null);
  }

  if (!message) return false;

  await message.edit({
    components: [buildHangmanBoard(game)],
    allowedMentions: { parse: [] },
  });
  return true;
}

async function handleSetup(interaction) {
  if (!isBotDeveloper(interaction.user)) {
    await interaction.reply({
      content: 'Only the bot developer can create Hangman.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!interaction.guild || !isOpenDevTicket(interaction.channel)) {
    await interaction.reply({
      content: 'This Hangman form is no longer in an open Dev test ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (
    String(interaction.customId.split(':')[2]) !==
    String(interaction.channel.id)
  ) {
    await interaction.reply({
      content: 'This Hangman form belongs to another ticket.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const word = normalizeSecret(
    interaction.fields.getTextInputValue('hangman_word'),
  );

  if (!word) {
    await interaction.reply({
      content: 'Use **2-40 characters** containing letters, spaces, apostrophes, or hyphens.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const hint = cleanText(
    interaction.fields.getTextInputValue('hangman_hint'),
  );

  return withLock(interaction.channel.id, async () => {
    const current = await getHangmanGame(
      interaction.guild.id,
      interaction.channel.id,
    );

    if (current?.status === 'active') {
      await interaction.reply({
        content: 'Another Hangman round was already started.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const now = new Date().toISOString();
    let game = {
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      gameId: newGameId(),
      hostId: interaction.user.id,
      messageId: null,
      word,
      hint,
      guessedLetters: [],
      wrongWordGuesses: [],
      playerIds: [],
      misses: 0,
      status: 'active',
      winnerId: null,
      endedById: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };

    await saveHangmanGame(game);

    try {
      await interaction.reply({
        components: [buildHangmanBoard(game)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });

      const message = await interaction.fetchReply();

      game = {
        ...game,
        messageId: message.id,
        updatedAt: new Date().toISOString(),
      };

      await saveHangmanGame(game);

      console.log(
        '[HANGMAN] Started ' + game.gameId +
        ' in ' + game.channelId +
        ' by ' + game.hostId + '.',
      );
    } catch (error) {
      await deleteHangmanGame(
        interaction.guild.id,
        interaction.channel.id,
        game.gameId,
      ).catch(() => {});
      throw error;
    }

    return true;
  });
}

async function openGuess(interaction, kind, id) {
  if (!isOpenDevTicket(interaction.channel)) {
    await interaction.reply({
      content: 'Hangman guessing is paused while this Dev ticket is closed.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const game = await getMatchingGame(interaction, id);

  if (!game || game.status !== 'active') {
    await interaction.reply({
      content: 'That Hangman round is no longer active.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (String(interaction.user.id) === String(game.hostId)) {
    await interaction.reply({
      content: 'You set the secret word, so you cannot guess in your own round \uD83D\uDE04',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.showModal(buildGuessModal(kind, id));
  return true;
}

function outcomeText(result) {
  if (result.outcome === 'correct') {
    return '\u2705 **' + result.value + '** is in the word!';
  }
  if (result.outcome === 'wrong') {
    return '\u274C **' + result.value + '** is not in the word.';
  }
  if (result.outcome === 'won') {
    return '\uD83C\uDFC6 **You got it!** The word has been solved.';
  }
  if (result.outcome === 'lost') {
    return '\uD83D\uDC80 That used the final chance. The word has been revealed.';
  }
  if (result.outcome === 'wrong-word') {
    return '\u274C **' + cleanText(result.value, 40) + '** is not the word.';
  }
  if (result.outcome === 'duplicate') {
    return '\u2139\uFE0F **' + result.value + '** has already been guessed.';
  }
  if (result.outcome === 'duplicate-word') {
    return '\u2139\uFE0F Someone already tried that word.';
  }
  return 'This Hangman round is no longer active.';
}

async function submitGuess(interaction, kind, id) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  if (!isOpenDevTicket(interaction.channel)) {
    await interaction.editReply({
      content: 'Hangman guessing is paused while this Dev ticket is closed.',
    });
    return true;
  }

  return withLock(interaction.channelId, async () => {
    const game = await getMatchingGame(interaction, id);

    if (!game || game.status !== 'active') {
      await interaction.editReply({
        content: 'That Hangman round is no longer active.',
      });
      return true;
    }

    if (String(interaction.user.id) === String(game.hostId)) {
      await interaction.editReply({
        content: 'You set the secret word, so you cannot guess in your own round.',
      });
      return true;
    }

    const raw = interaction.fields.getTextInputValue('hangman_guess');
    const normalized =
      kind === 'letter'
        ? normalizeLetterGuess(raw)
        : normalizeWordGuess(raw);

    if (!normalized) {
      await interaction.editReply({
        content:
          kind === 'letter'
            ? 'Enter exactly **one letter A-Z**.'
            : 'Enter a valid word or phrase using letters, spaces, apostrophes, or hyphens.',
      });
      return true;
    }

    const result =
      kind === 'letter'
        ? applyLetterGuess(game, interaction.user.id, normalized)
        : applyWordGuess(game, interaction.user.id, normalized);

    if (result.changed) {
      const now = new Date().toISOString();
      const next = {
        ...result.game,
        updatedAt: now,
        endedAt: result.game.status === 'active' ? null : now,
      };

      await saveHangmanGame(next);
      await refreshBoard(interaction, next).catch((error) => {
        console.error('[HANGMAN BOARD REFRESH ERROR]', error);
      });
    }

    await interaction.editReply({
      content: outcomeText(result),
    });

    return true;
  });
}

async function endGame(interaction, id) {
  if (!isBotDeveloper(interaction.user)) {
    await interaction.reply({
      content: 'Only the bot developer can end this Hangman round.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return withLock(interaction.channelId, async () => {
    const game = await getMatchingGame(interaction, id);

    if (!game || game.status !== 'active') {
      await interaction.reply({
        content: 'That Hangman round is no longer active.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const now = new Date().toISOString();
    const ended = {
      ...game,
      status: 'ended',
      endedById: interaction.user.id,
      endedAt: now,
      updatedAt: now,
    };

    await saveHangmanGame(ended);

    await interaction.update({
      components: [buildHangmanBoard(ended)],
      allowedMentions: { parse: [] },
    });

    return true;
  });
}

async function handleHangmanInteraction(interaction) {
  const id = String(interaction.customId || '');
  if (!id.startsWith('hangman:')) return false;

  const [, action, value] = id.split(':');

  if (interaction.isModalSubmit?.() && action === 'setup') {
    return handleSetup(interaction);
  }
  if (interaction.isButton?.() && action === 'letter') {
    return openGuess(interaction, 'letter', value);
  }
  if (interaction.isButton?.() && action === 'word') {
    return openGuess(interaction, 'word', value);
  }
  if (interaction.isButton?.() && action === 'end') {
    return endGame(interaction, value);
  }
  if (interaction.isModalSubmit?.() && action === 'guess-letter') {
    return submitGuess(interaction, 'letter', value);
  }
  if (interaction.isModalSubmit?.() && action === 'guess-word') {
    return submitGuess(interaction, 'word', value);
  }

  return true;
}

module.exports = {
  openHangmanSetup,
  handleHangmanInteraction,
  buildHangmanBoard,
  isOpenDevTicket,
};
