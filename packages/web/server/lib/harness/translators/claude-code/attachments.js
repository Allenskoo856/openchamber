/**
 * Map OpenChamber attached files → Claude Agent SDK content blocks.
 * Rejects opaque binaries; never logs attachment contents.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const TEXT_LIKE_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_MIME = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
]);

/**
 * @typedef {{ mime?: string, url?: string, filename?: string }} AttachedFile
 */

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isImageMime(mime) {
  return IMAGE_MIME.has(String(mime || '').toLowerCase());
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isTextLikeMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (TEXT_LIKE_MIME.has(normalized)) return true;
  return TEXT_LIKE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isPdfMime(mime) {
  return String(mime || '').toLowerCase() === 'application/pdf';
}

/**
 * @param {string} mime
 * @returns {boolean}
 */
export function isSupportedAttachmentMime(mime) {
  return isImageMime(mime) || isTextLikeMime(mime) || isPdfMime(mime);
}

/**
 * @param {string} dataUrl
 * @returns {{ mime: string, base64: string, bytes: number } | null}
 */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const data = dataUrl.slice(comma + 1);
  const parts = header.split(';');
  const mime = (parts[0] || '').toLowerCase() || 'application/octet-stream';
  const isBase64 = parts.some((part) => part.trim() === 'base64');
  if (!isBase64) {
    // Percent-encoded payload — decode to utf-8 then re-encode as base64 for size.
    try {
      const decoded = decodeURIComponent(data);
      const base64 = Buffer.from(decoded, 'utf8').toString('base64');
      return { mime, base64, bytes: Buffer.byteLength(decoded, 'utf8') };
    } catch {
      return null;
    }
  }
  const bytes = Math.floor((data.length * 3) / 4);
  return { mime, base64: data, bytes };
}

/**
 * @param {AttachedFile} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ block: Record<string, unknown>, bytes: number, filename: string }}
 */
export function mapAttachmentToContentBlock(file, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_ATTACHMENT_BYTES;
  const filename = typeof file?.filename === 'string' && file.filename.trim()
    ? file.filename.trim()
    : 'attachment';
  const declaredMime = typeof file?.mime === 'string' ? file.mime.toLowerCase() : '';
  const url = typeof file?.url === 'string' ? file.url : '';

  if (!url) {
    const error = new Error(`Attachment "${filename}" has no url`);
    error.code = 'ATTACHMENT_INVALID';
    error.statusCode = 400;
    throw error;
  }

  if (!url.startsWith('data:')) {
    const error = new Error(`Attachment "${filename}" must be a data URL in v1`);
    error.code = 'ATTACHMENT_UNSUPPORTED_URL';
    error.statusCode = 400;
    throw error;
  }

  const parsed = parseDataUrl(url);
  if (!parsed) {
    const error = new Error(`Attachment "${filename}" could not be parsed`);
    error.code = 'ATTACHMENT_INVALID';
    error.statusCode = 400;
    throw error;
  }

  const mime = declaredMime || parsed.mime;
  if (!isSupportedAttachmentMime(mime)) {
    const error = new Error(`Attachment "${filename}" type "${mime}" is not supported`);
    error.code = 'ATTACHMENT_UNSUPPORTED_TYPE';
    error.statusCode = 400;
    throw error;
  }

  if (parsed.bytes > maxBytes) {
    const error = new Error(`Attachment "${filename}" exceeds max size of ${maxBytes} bytes`);
    error.code = 'ATTACHMENT_TOO_LARGE';
    error.statusCode = 400;
    throw error;
  }

  if (isImageMime(mime)) {
    const mediaType = mime === 'image/jpg' ? 'image/jpeg' : mime;
    return {
      filename,
      bytes: parsed.bytes,
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: parsed.base64,
        },
      },
    };
  }

  if (isPdfMime(mime)) {
    return {
      filename,
      bytes: parsed.bytes,
      block: {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: parsed.base64,
        },
      },
    };
  }

  // Text-like: decode and send as labeled text (never log contents).
  let text;
  try {
    text = Buffer.from(parsed.base64, 'base64').toString('utf8');
  } catch {
    const error = new Error(`Attachment "${filename}" could not be decoded as text`);
    error.code = 'ATTACHMENT_INVALID';
    error.statusCode = 400;
    throw error;
  }

  return {
    filename,
    bytes: parsed.bytes,
    block: {
      type: 'text',
      text: `Attached file: ${filename}\n\n${text}`,
    },
  };
}

/**
 * @param {AttachedFile[] | undefined | null} files
 * @param {{ maxFileBytes?: number, maxTurnBytes?: number }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function mapAttachmentsToContentBlocks(files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const maxFileBytes = options.maxFileBytes ?? MAX_ATTACHMENT_BYTES;
  const maxTurnBytes = options.maxTurnBytes ?? MAX_TURN_ATTACHMENT_BYTES;
  const blocks = [];
  let total = 0;
  for (const file of files) {
    const mapped = mapAttachmentToContentBlock(file, { maxBytes: maxFileBytes });
    total += mapped.bytes;
    if (total > maxTurnBytes) {
      const error = new Error(`Attachments exceed max turn size of ${maxTurnBytes} bytes`);
      error.code = 'ATTACHMENTS_TOO_LARGE';
      error.statusCode = 400;
      throw error;
    }
    blocks.push(mapped.block);
  }
  return blocks;
}
