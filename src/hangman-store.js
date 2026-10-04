const {
  getMongoDb,
} = require('./database');

const COLLECTION =
  'bot_settings';

function documentId(
  guildId,
  channelId,
) {
  return (
    `hangman:${String(guildId)}:${String(channelId)}`
  );
}

function normalizeGame(
  document,
) {
  if (!document) {
    return null;
  }

  return {
    guildId:
      String(
        document.guildId,
      ),
    channelId:
      String(
        document.channelId,
      ),
    gameId:
      String(
        document.gameId ||
        '',
      ),
    hostId:
      String(
        document.hostId ||
        '',
      ),
    messageId:
      document.messageId
        ? String(
            document.messageId,
          )
        : null,
    word:
      String(
        document.word ||
        '',
      ),
    hint:
      String(
        document.hint ||
        '',
      ),
    guessedLetters:
      Array.isArray(
        document.guessedLetters,
      )
        ? document.guessedLetters
            .map(
              String,
            )
            .slice(
              0,
              26,
            )
        : [],
    wrongWordGuesses:
      Array.isArray(
        document.wrongWordGuesses,
      )
        ? document.wrongWordGuesses
            .map(
              String,
            )
            .slice(
              -8,
            )
        : [],
    playerIds:
      Array.isArray(
        document.playerIds,
      )
        ? [
            ...new Set(
              document.playerIds.map(
                String,
              ),
            ),
          ].slice(
            0,
            100,
          )
        : [],
    misses:
      Math.max(
        0,
        Number(
          document.misses,
        ) ||
          0,
      ),
    status:
      [
        'active',
        'won',
        'lost',
        'ended',
      ].includes(
        document.status,
      )
        ? document.status
        : 'active',
    winnerId:
      document.winnerId
        ? String(
            document.winnerId,
          )
        : null,
    endedById:
      document.endedById
        ? String(
            document.endedById,
          )
        : null,
    createdAt:
      document.createdAt ||
      null,
    updatedAt:
      document.updatedAt ||
      null,
    endedAt:
      document.endedAt ||
      null,
  };
}

async function collection() {
  return (
    await getMongoDb()
  ).collection(
    COLLECTION,
  );
}

async function getHangmanGame(
  guildId,
  channelId,
) {
  const document =
    await (
      await collection()
    ).findOne({
      _id:
        documentId(
          guildId,
          channelId,
        ),
    });

  return normalizeGame(
    document,
  );
}

async function saveHangmanGame(
  game,
) {
  if (
    !game?.guildId ||
    !game?.channelId ||
    !game?.gameId
  ) {
    throw new Error(
      'Invalid Hangman game state.',
    );
  }

  const payload = {
    kind:
      'hangman_game',
    guildId:
      String(
        game.guildId,
      ),
    channelId:
      String(
        game.channelId,
      ),
    gameId:
      String(
        game.gameId,
      ),
    hostId:
      String(
        game.hostId,
      ),
    messageId:
      game.messageId
        ? String(
            game.messageId,
          )
        : null,
    word:
      String(
        game.word,
      ),
    hint:
      String(
        game.hint ||
        '',
      ),
    guessedLetters:
      Array.isArray(
        game.guessedLetters,
      )
        ? game.guessedLetters.map(
            String,
          )
        : [],
    wrongWordGuesses:
      Array.isArray(
        game.wrongWordGuesses,
      )
        ? game.wrongWordGuesses.map(
            String,
          )
        : [],
    playerIds:
      Array.isArray(
        game.playerIds,
      )
        ? [
            ...new Set(
              game.playerIds.map(
                String,
              ),
            ),
          ]
        : [],
    misses:
      Math.max(
        0,
        Number(
          game.misses,
        ) ||
          0,
      ),
    status:
      game.status ||
      'active',
    winnerId:
      game.winnerId
        ? String(
            game.winnerId,
          )
        : null,
    endedById:
      game.endedById
        ? String(
            game.endedById,
          )
        : null,
    createdAt:
      game.createdAt ||
      new Date().toISOString(),
    updatedAt:
      game.updatedAt ||
      new Date().toISOString(),
    endedAt:
      game.endedAt ||
      null,
  };

  await (
    await collection()
  ).updateOne(
    {
      _id:
        documentId(
          payload.guildId,
          payload.channelId,
        ),
    },
    {
      $set:
        payload,
    },
    {
      upsert:
        true,
    },
  );

  return normalizeGame(
    payload,
  );
}

async function deleteHangmanGame(
  guildId,
  channelId,
  gameId = null,
) {
  const filter = {
    _id:
      documentId(
        guildId,
        channelId,
      ),
  };

  if (gameId) {
    filter.gameId =
      String(
        gameId,
      );
  }

  return (
    await (
      await collection()
    ).deleteOne(
      filter,
    )
  ).deletedCount >
    0;
}

module.exports = {
  getHangmanGame,
  saveHangmanGame,
  deleteHangmanGame,
};
