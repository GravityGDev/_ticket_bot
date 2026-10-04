const MAX_MISSES = 6;

function normalizeLetters(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase();
}

function normalizeSecret(value) {
  const normalized = normalizeLetters(value)
    .replace(/\s+/g, ' ')
    .trim();

  if (
    normalized.length < 2 ||
    normalized.length > 40 ||
    !/^[A-Z][A-Z '\-]*[A-Z]$/.test(normalized) ||
    normalized.replace(/[^A-Z]/g, '').length < 2
  ) {
    return null;
  }

  return normalized;
}

function normalizeLetterGuess(value) {
  const normalized = normalizeLetters(value).trim();
  return /^[A-Z]$/.test(normalized)
    ? normalized
    : null;
}

function normalizeWordGuess(value) {
  const normalized = normalizeLetters(value)
    .replace(/\s+/g, ' ')
    .trim();

  if (
    !normalized ||
    normalized.length > 40 ||
    !/^[A-Z][A-Z '\-]*[A-Z]$/.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function uniqueWordLetters(word) {
  return [
    ...new Set(
      String(word || '')
        .split('')
        .filter((character) =>
          /[A-Z]/.test(
            character,
          ),
        ),
    ),
  ];
}

function isWordSolved(
  word,
  guessedLetters,
) {
  const guessed =
    new Set(
      guessedLetters || [],
    );

  return uniqueWordLetters(
    word,
  ).every(
    (letter) =>
      guessed.has(
        letter,
      ),
  );
}

function maskWord(
  word,
  guessedLetters,
) {
  const guessed =
    new Set(
      guessedLetters || [],
    );

  return String(
    word ||
    '',
  )
    .split('')
    .map(
      (character) => {
        if (/[A-Z]/.test(character)) {
          return guessed.has(character)
            ? character
            : '▢';
        }

        if (character === ' ') {
          return '/';
        }

        return character;
      },
    )
    .join(' ');
}

function addPlayer(
  game,
  userId,
) {
  const players =
    new Set(
      Array.isArray(
        game.playerIds,
      )
        ? game.playerIds.map(
            String,
          )
        : [],
    );

  players.add(
    String(
      userId,
    ),
  );

  return [
    ...players,
  ];
}

function applyLetterGuess(
  game,
  userId,
  rawGuess,
) {
  const letter =
    normalizeLetterGuess(
      rawGuess,
    );

  if (!letter) {
    return {
      game,
      changed: false,
      outcome: 'invalid',
      value: null,
    };
  }

  if (
    game.status !==
      'active'
  ) {
    return {
      game,
      changed: false,
      outcome: 'inactive',
      value: letter,
    };
  }

  const guessed =
    new Set(
      Array.isArray(
        game.guessedLetters,
      )
        ? game.guessedLetters
        : [],
    );

  if (
    guessed.has(
      letter,
    )
  ) {
    return {
      game,
      changed: false,
      outcome: 'duplicate',
      value: letter,
    };
  }

  guessed.add(
    letter,
  );

  const next = {
    ...game,
    guessedLetters: [
      ...guessed,
    ],
    playerIds:
      addPlayer(
        game,
        userId,
      ),
  };

  if (
    String(
      game.word,
    ).includes(
      letter,
    )
  ) {
    if (
      isWordSolved(
        game.word,
        next.guessedLetters,
      )
    ) {
      next.status =
        'won';
      next.winnerId =
        String(
          userId,
        );

      return {
        game: next,
        changed: true,
        outcome: 'won',
        value: letter,
      };
    }

    return {
      game: next,
      changed: true,
      outcome: 'correct',
      value: letter,
    };
  }

  next.misses =
    Math.min(
      MAX_MISSES,
      Number(
        game.misses,
      ) +
        1,
    );

  if (
    next.misses >=
      MAX_MISSES
  ) {
    next.status =
      'lost';

    return {
      game: next,
      changed: true,
      outcome: 'lost',
      value: letter,
    };
  }

  return {
    game: next,
    changed: true,
    outcome: 'wrong',
    value: letter,
  };
}

function applyWordGuess(
  game,
  userId,
  rawGuess,
) {
  const guess =
    normalizeWordGuess(
      rawGuess,
    );

  if (!guess) {
    return {
      game,
      changed: false,
      outcome: 'invalid',
      value: null,
    };
  }

  if (
    game.status !==
      'active'
  ) {
    return {
      game,
      changed: false,
      outcome: 'inactive',
      value: guess,
    };
  }

  if (
    guess ===
      game.word
  ) {
    return {
      game: {
        ...game,
        status:
          'won',
        winnerId:
          String(
            userId,
          ),
        playerIds:
          addPlayer(
            game,
            userId,
          ),
      },
      changed: true,
      outcome: 'won',
      value: guess,
    };
  }

  const wrongWords =
    Array.isArray(
      game.wrongWordGuesses,
    )
      ? [
          ...game.wrongWordGuesses,
        ]
      : [];

  if (
    wrongWords.includes(
      guess,
    )
  ) {
    return {
      game,
      changed: false,
      outcome: 'duplicate-word',
      value: guess,
    };
  }

  wrongWords.push(
    guess,
  );

  const next = {
    ...game,
    wrongWordGuesses:
      wrongWords.slice(
        -8,
      ),
    playerIds:
      addPlayer(
        game,
        userId,
      ),
    misses:
      Math.min(
        MAX_MISSES,
        Number(
          game.misses,
        ) +
          1,
      ),
  };

  if (
    next.misses >=
      MAX_MISSES
  ) {
    next.status =
      'lost';

    return {
      game: next,
      changed: true,
      outcome: 'lost',
      value: guess,
    };
  }

  return {
    game: next,
    changed: true,
    outcome: 'wrong-word',
    value: guess,
  };
}

module.exports = {
  MAX_MISSES,
  normalizeSecret,
  normalizeLetterGuess,
  normalizeWordGuess,
  maskWord,
  isWordSolved,
  applyLetterGuess,
  applyWordGuess,
};
