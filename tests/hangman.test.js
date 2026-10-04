const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_MISSES,
  normalizeSecret,
  maskWord,
  applyLetterGuess,
  applyWordGuess,
} = require('../src/hangman-logic');

function game(word = 'COMMAND SYSTEMS') {
  return {
    word,
    guessedLetters: [],
    wrongWordGuesses: [],
    playerIds: [],
    misses: 0,
    status: 'active',
    winnerId: null,
  };
}

test('hangman masks phrases and preserves separators', () => {
  assert.equal(normalizeSecret('Command Systems'), 'COMMAND SYSTEMS');
  assert.equal(maskWord('COMMAND SYSTEMS', ['C', 'M']), 'C ▢ M M ▢ ▢ ▢ / ▢ ▢ ▢ ▢ ▢ M ▢');
});

test('correct letters reveal without costing a chance', () => {
  const result = applyLetterGuess(game('CAT'), 'user', 'C');
  assert.equal(result.outcome, 'correct');
  assert.equal(result.game.misses, 0);
  assert.deepEqual(result.game.guessedLetters, ['C']);
});

test('duplicate guesses do not cost extra chances', () => {
  const first = applyLetterGuess(game('CAT'), 'user', 'X');
  const duplicate = applyLetterGuess(first.game, 'other', 'X');
  assert.equal(first.game.misses, 1);
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(duplicate.game.misses, 1);
});

test('full-word guesses can win and wrong words cost one chance', () => {
  const wrong = applyWordGuess(game('COMMAND SYSTEMS'), 'user', 'COMMAND');
  assert.equal(wrong.outcome, 'wrong-word');
  assert.equal(wrong.game.misses, 1);

  const won = applyWordGuess(wrong.game, 'winner', 'COMMAND SYSTEMS');
  assert.equal(won.outcome, 'won');
  assert.equal(won.game.status, 'won');
  assert.equal(won.game.winnerId, 'winner');
});

test('six mistakes ends the round', () => {
  let current = game('A');
  for (const letter of ['B', 'C', 'D', 'E', 'F', 'G']) {
    current = applyLetterGuess(current, 'user', letter).game;
  }
  assert.equal(current.misses, MAX_MISSES);
  assert.equal(current.status, 'lost');
});

test('hangman UI is Components V2 and command is developer scoped', () => {
  const gameSource = fs.readFileSync(path.join(__dirname, '../src/hangman-game.js'), 'utf8');
  const commandSource = fs.readFileSync(path.join(__dirname, '../src/commands/hangman.js'), 'utf8');
  assert.match(gameSource, /ContainerBuilder/);
  assert.match(gameSource, /MessageFlags\.IsComponentsV2/);
  assert.match(gameSource, /Type=dev_test/);
  assert.match(commandSource, /isBotDeveloper/);
  assert.match(commandSource, /setName\('hangman'\)/);
});
