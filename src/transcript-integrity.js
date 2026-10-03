const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');
const { getMongoDb } = require('./database');

const COLLECTION_NAME = 'bot_settings';
const LEGACY_COLLECTION_NAME = 'transcript_integrity';
const integrityDocumentId = id => `transcript_integrity:${id}`;

const TRANSCRIPT_INTEGRITY_SLOT =
  '<!-- SNAY_TRANSCRIPT_INTEGRITY_SLOT -->';

const TRANSCRIPT_INTEGRITY_START =
  '<!-- SNAY_TRANSCRIPT_INTEGRITY_START -->';

const TRANSCRIPT_INTEGRITY_END =
  '<!-- SNAY_TRANSCRIPT_INTEGRITY_END -->';

function getSigningSecret() {
  const secret = String(
    process.env.TRANSCRIPT_SIGNING_SECRET || '',
  );

  if (secret.length < 32) {
    throw new Error(
      'TRANSCRIPT_SIGNING_SECRET is missing or too short. ' +
        'Set a private signing secret of at least 32 characters in your bot hosting environment (Dokploy).',
    );
  }

  return secret;
}

async function collection() {
  const db = await getMongoDb();
  return db.collection(COLLECTION_NAME);
}

function sha256Hex(value) {
  return createHash('sha256')
    .update(
      Buffer.from(
        String(value),
        'utf8',
      ),
    )
    .digest('hex');
}

function hmacHex(
  transcriptId,
  sha256,
) {
  return createHmac(
    'sha256',
    getSigningSecret(),
  )
    .update(
      `${transcriptId}:${sha256}`,
      'utf8',
    )
    .digest('hex');
}

function safeHexEqual(
  left,
  right,
) {
  const a = String(
    left || '',
  ).toLowerCase();

  const b = String(
    right || '',
  ).toLowerCase();

  if (
    !/^[a-f0-9]{64}$/.test(a) ||
    !/^[a-f0-9]{64}$/.test(b)
  ) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(a, 'hex'),
    Buffer.from(b, 'hex'),
  );
}

function transcriptDateStamp(
  date = new Date(),
) {
  const year =
    date.getUTCFullYear();

  const month = String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0');

  const day = String(
    date.getUTCDate(),
  ).padStart(2, '0');

  return `${year}${month}${day}`;
}

function generateTranscriptId(
  ticketNumber,
) {
  const ticket =
    String(
      ticketNumber ?? 'X',
    )
      .replace(
        /[^A-Za-z0-9_-]/g,
        '',
      )
      .slice(0, 16) ||
    'X';

  return (
    `TR-${ticket}-` +
    `${transcriptDateStamp()}-` +
    randomBytes(5)
      .toString('hex')
      .toUpperCase()
  );
}

function escapeIntegrityHtml(value) {
  return String(
    value ?? '',
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderIntegritySection(
  integrity,
) {
  return `${TRANSCRIPT_INTEGRITY_START}
<section
  class="integrity-card"
  id="transcript-integrity"
  data-transcript-id="${escapeIntegrityHtml(
    integrity.transcriptId,
  )}"
  data-sha256="${escapeIntegrityHtml(
    integrity.sha256,
  )}"
  data-signature="${escapeIntegrityHtml(
    integrity.signature,
  )}"
  data-algorithm="HMAC-SHA256"
>
  <h2>🛡️ Transcript Integrity</h2>
  <div class="integrity-subtitle">
    Cryptographically signed by Snay Ticket Tool
  </div>

  <div class="integrity-grid">
    <div class="integrity-item">
      <span>Transcript ID</span>
      <b>${escapeIntegrityHtml(
        integrity.transcriptId,
      )}</b>
    </div>

    <div class="integrity-item">
      <span>Verification</span>
      <b class="integrity-valid">✅ Signed</b>
    </div>

    <div class="integrity-item">
      <span>SHA-256</span>
      <code>${escapeIntegrityHtml(
        integrity.sha256,
      )}</code>
    </div>

    <div class="integrity-item">
      <span>HMAC-SHA256 Signature</span>
      <code>${escapeIntegrityHtml(
        integrity.signature,
      )}</code>
    </div>

    <div class="integrity-item">
      <span>Generated</span>
      <b>${escapeIntegrityHtml(
        new Date(
          integrity.generatedAt,
        ).toLocaleString(
          'en-GB',
        ),
      )}</b>
    </div>

    <div class="integrity-item">
      <span>Algorithm</span>
      <b>SHA-256 + HMAC-SHA256</b>
    </div>
  </div>

  <div class="integrity-help">
    Upload this HTML file to <b>/verify-transcript</b> to verify that
    the transcript still exactly matches the copy signed by Snay.io.
  </div>
</section>
${TRANSCRIPT_INTEGRITY_END}`;
}

function escapeRegex(value) {
  return String(
    value,
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
}

function parseIntegrityBlock(
  html,
) {
  const source =
    String(
      html || '',
    );

  const pattern =
    new RegExp(
      `${escapeRegex(
        TRANSCRIPT_INTEGRITY_START,
      )}[\\s\\S]*?${escapeRegex(
        TRANSCRIPT_INTEGRITY_END,
      )}`,
    );

  const match =
    source.match(
      pattern,
    );

  if (!match) {
    return {
      found: false,
      error:
        'This file does not contain a Snay transcript integrity block.',
    };
  }

  const block =
    match[0];

  const idMatch =
    block.match(
      /data-transcript-id="([^"]+)"/,
    );

  const shaMatch =
    block.match(
      /data-sha256="([a-fA-F0-9]{64})"/,
    );

  const signatureMatch =
    block.match(
      /data-signature="([a-fA-F0-9]{64})"/,
    );

  if (
    !idMatch ||
    !shaMatch ||
    !signatureMatch
  ) {
    return {
      found: false,
      error:
        'The transcript integrity block is incomplete or malformed.',
    };
  }

  const canonicalHtml =
    source.replace(
      block,
      TRANSCRIPT_INTEGRITY_SLOT,
    );

  return {
    found: true,
    canonicalHtml,
    transcriptId:
      idMatch[1],
    sha256:
      shaMatch[1].toLowerCase(),
    signature:
      signatureMatch[1].toLowerCase(),
  };
}

async function storeTranscriptIntegrity(
  record,
) {
  await (
    await collection()
  ).insertOne({
    _id:
      integrityDocumentId(record.transcriptId),
    transcriptId:
      record.transcriptId,
    sha256:
      record.sha256,
    signature:
      record.signature,
    algorithm:
      'HMAC-SHA256',
    hashAlgorithm:
      'SHA-256',
    generatedAt:
      new Date(
        record.generatedAt,
      ),
    metadata:
      record.metadata || {},
    verificationCount:
      0,
    createdAt:
      new Date(),
  });
}

async function signAndStoreTranscript({
  canonicalHtml,
  metadata = {},
}) {
  const source =
    String(
      canonicalHtml || '',
    );

  const slotCount =
    source.split(
      TRANSCRIPT_INTEGRITY_SLOT,
    ).length - 1;

  if (slotCount !== 1) {
    throw new Error(
      'Transcript integrity slot is missing or duplicated.',
    );
  }

  getSigningSecret();

  const transcriptId =
    generateTranscriptId(
      metadata.ticketNumber,
    );

  const generatedAt =
    new Date().toISOString();

  const sha256 =
    sha256Hex(
      source,
    );

  const signature =
    hmacHex(
      transcriptId,
      sha256,
    );

  const integrity = {
    transcriptId,
    sha256,
    signature,
    generatedAt,
  };

  const html =
    source.replace(
      TRANSCRIPT_INTEGRITY_SLOT,
      renderIntegritySection(
        integrity,
      ),
    );

  await storeTranscriptIntegrity({
    ...integrity,
    metadata,
  });

  return {
    html,
    integrity,
  };
}

async function getTranscriptIntegrityRecord(transcriptId) {
  const db = await getMongoDb();
  return await db.collection(COLLECTION_NAME).findOne({ _id: integrityDocumentId(transcriptId) }) ||
    await db.collection(LEGACY_COLLECTION_NAME).findOne({ _id: String(transcriptId) });
}

async function recordVerificationAttempt(
  transcriptId,
  valid,
  details = {},
) {
  const db = await getMongoDb();
  const current = await db.collection(COLLECTION_NAME).findOne({ _id: integrityDocumentId(transcriptId) });
  await db.collection(current ? COLLECTION_NAME : LEGACY_COLLECTION_NAME).updateOne(
    { _id: current ? integrityDocumentId(transcriptId) : String(transcriptId) },
    {
      $inc: {
        verificationCount:
          1,
      },
      $set: {
        lastVerifiedAt:
          new Date(),
        lastVerificationValid:
          Boolean(
            valid,
          ),
        lastVerificationDetails:
          details,
      },
    },
  );
}

async function verifyTranscriptHtml(
  html,
) {
  const parsed =
    parseIntegrityBlock(
      html,
    );

  if (!parsed.found) {
    return {
      valid: false,
      parsed: false,
      reason:
        parsed.error,
      checks: {
        contentHash:
          false,
        hmac:
          false,
        databaseRecord:
          false,
        databaseHash:
          false,
        databaseSignature:
          false,
      },
    };
  }

  const recomputedSha256 =
    sha256Hex(
      parsed.canonicalHtml,
    );

  const contentHash =
    safeHexEqual(
      recomputedSha256,
      parsed.sha256,
    );

  let expectedSignature;

  try {
    expectedSignature =
      hmacHex(
        parsed.transcriptId,
        parsed.sha256,
      );
  } catch (error) {
    return {
      valid: false,
      parsed: true,
      transcriptId:
        parsed.transcriptId,
      embeddedSha256:
        parsed.sha256,
      recomputedSha256,
      reason:
        error.message,
      checks: {
        contentHash,
        hmac:
          false,
        databaseRecord:
          false,
        databaseHash:
          false,
        databaseSignature:
          false,
      },
    };
  }

  const hmacValid =
    safeHexEqual(
      expectedSignature,
      parsed.signature,
    );

  const databaseRecord =
    await getTranscriptIntegrityRecord(
      parsed.transcriptId,
    );

  const databaseRecordFound =
    Boolean(
      databaseRecord,
    );

  const databaseHash =
    databaseRecordFound &&
    safeHexEqual(
      databaseRecord.sha256,
      parsed.sha256,
    );

  const databaseSignature =
    databaseRecordFound &&
    safeHexEqual(
      databaseRecord.signature,
      parsed.signature,
    );

  const valid =
    contentHash &&
    hmacValid &&
    databaseRecordFound &&
    databaseHash &&
    databaseSignature;

  if (databaseRecordFound) {
    await recordVerificationAttempt(
      parsed.transcriptId,
      valid,
      {
        contentHash,
        hmac:
          hmacValid,
        databaseHash,
        databaseSignature,
      },
    ).catch(
      (error) => {
        console.error(
          '[TRANSCRIPT VERIFY AUDIT ERROR]',
          error,
        );
      },
    );
  }

  return {
    valid,
    parsed: true,
    transcriptId:
      parsed.transcriptId,
    embeddedSha256:
      parsed.sha256,
    recomputedSha256,
    embeddedSignature:
      parsed.signature,
    databaseRecord,
    checks: {
      contentHash,
      hmac:
        hmacValid,
      databaseRecord:
        databaseRecordFound,
      databaseHash,
      databaseSignature,
    },
    reason:
      valid
        ? 'Transcript is authentic and unchanged.'
        : 'One or more transcript integrity checks failed.',
  };
}

module.exports = {
  COLLECTION_NAME,
  TRANSCRIPT_INTEGRITY_SLOT,
  signAndStoreTranscript,
  verifyTranscriptHtml,
  getTranscriptIntegrityRecord,
};
