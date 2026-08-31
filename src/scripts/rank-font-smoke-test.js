const fs =
  require('node:fs');

const path =
  require('node:path');

const {
  configureRankFonts,
} =
  require('../src/rank-font-runtime');

configureRankFonts();

const sharp =
  require('sharp');

async function main() {
  const svg =
    Buffer.from(`
      <svg width="900" height="260"
           xmlns="http://www.w3.org/2000/svg">
        <rect width="900" height="260"
              fill="#07121f"/>
        <text x="40" y="100"
              font-family="DejaVu Sans, sans-serif"
              font-size="52"
              font-weight="700"
              fill="#ffffff">SNAY.IO RANK CARD</text>
        <text x="40" y="180"
              font-family="DejaVu Sans, sans-serif"
              font-size="38"
              fill="#35dbd4">LEVEL 12 • TICKETS 24 • ACTIVITY 491</text>
      </svg>
    `);

  const output =
    path.join(
      process.cwd(),
      'rank-font-smoke-test.png',
    );

  await sharp(
    svg,
  )
    .png()
    .toFile(
      output,
    );

  console.log(
    `Rank font smoke test written to ${output}`,
  );
}

main().catch(
  (error) => {
    console.error(
      error,
    );

    process.exit(
      1,
    );
  },
);
