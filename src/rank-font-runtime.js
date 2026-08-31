const fs =
  require('node:fs');

const os =
  require('node:os');

const path =
  require('node:path');

let configured =
  false;

function escapeXml(
  value,
) {
  return String(
    value ||
      '',
  )
    .replaceAll(
      '&',
      '&amp;',
    )
    .replaceAll(
      '<',
      '&lt;',
    )
    .replaceAll(
      '>',
      '&gt;',
    )
    .replaceAll(
      '"',
      '&quot;',
    )
    .replaceAll(
      "'",
      '&apos;',
    );
}

function configureRankFonts() {
  if (
    configured
  ) {
    return;
  }

  configured =
    true;

  try {
    const regularFontPath =
      require.resolve(
        'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
      );

    const fontDirectory =
      path.dirname(
        regularFontPath,
      );

    const configDirectory =
      path.join(
        os.tmpdir(),
        'snay-rank-fontconfig',
      );

    const cacheDirectory =
      path.join(
        configDirectory,
        'cache',
      );

    fs.mkdirSync(
      cacheDirectory,
      {
        recursive:
          true,
      },
    );

    const configPath =
      path.join(
        configDirectory,
        'fonts.conf',
      );

    const configXml =
      `<?xml version="1.0"?>
<fontconfig>
  <dir>${escapeXml(fontDirectory)}</dir>
  <cachedir>${escapeXml(cacheDirectory)}</cachedir>

  <alias>
    <family>Arial</family>
    <prefer>
      <family>DejaVu Sans</family>
    </prefer>
  </alias>

  <alias>
    <family>Helvetica</family>
    <prefer>
      <family>DejaVu Sans</family>
    </prefer>
  </alias>

  <alias>
    <family>sans-serif</family>
    <prefer>
      <family>DejaVu Sans</family>
    </prefer>
  </alias>

  <match target="pattern">
    <test name="family" qual="any">
      <string>sans-serif</string>
    </test>
    <edit name="family" mode="prepend" binding="strong">
      <string>DejaVu Sans</string>
    </edit>
  </match>
</fontconfig>
`;

    fs.writeFileSync(
      configPath,
      configXml,
      'utf8',
    );

    // Fontconfig resolves FONTCONFIG_FILE relative to FONTCONFIG_PATH.
    // Both are set before Sharp/librsvg is loaded by staff-rank.js.
    process.env.FONTCONFIG_PATH =
      configDirectory;

    process.env.FONTCONFIG_FILE =
      path.basename(
        configPath,
      );

    console.log(
      `[RANK FONT] Using bundled DejaVu Sans from ${fontDirectory}.`,
    );
  } catch (error) {
    configured =
      false;

    console.error(
      '[RANK FONT CONFIG ERROR]',
      error,
    );

    throw new Error(
      'Could not configure the bundled rank-card font. ' +
        'Make sure dejavu-fonts-ttf is installed.',
      {
        cause:
          error,
      },
    );
  }
}

module.exports = {
  configureRankFonts,
};
