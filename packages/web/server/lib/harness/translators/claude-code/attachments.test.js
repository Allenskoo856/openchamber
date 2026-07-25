import { describe, expect, it } from 'bun:test';
import {
  isSupportedAttachmentMime,
  mapAttachmentToContentBlock,
  mapAttachmentsToContentBlocks,
} from './attachments.js';

describe('claude-code attachments', () => {
  it('maps image/png data URL to an SDK image block', () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const mapped = mapAttachmentToContentBlock({
      mime: 'image/png',
      filename: 'shot.png',
      url: `data:image/png;base64,${pngBase64}`,
    });

    expect(mapped.block).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: pngBase64,
      },
    });
    expect(isSupportedAttachmentMime('image/png')).toBe(true);
  });

  it('rejects application/zip with a clear error', () => {
    const zipBase64 = Buffer.from('PK').toString('base64');
    expect(() => mapAttachmentToContentBlock({
      mime: 'application/zip',
      filename: 'archive.zip',
      url: `data:application/zip;base64,${zipBase64}`,
    })).toThrow(/not supported/);

    try {
      mapAttachmentToContentBlock({
        mime: 'application/zip',
        filename: 'archive.zip',
        url: `data:application/zip;base64,${zipBase64}`,
      });
    } catch (error) {
      expect(error.code).toBe('ATTACHMENT_UNSUPPORTED_TYPE');
      expect(error.statusCode).toBe(400);
    }
  });

  it('maps multiple attachments and rejects oversize turns', () => {
    const text = Buffer.from('hello').toString('base64');
    const blocks = mapAttachmentsToContentBlocks([
      {
        mime: 'text/plain',
        filename: 'note.txt',
        url: `data:text/plain;base64,${text}`,
      },
    ]);
    expect(blocks[0].type).toBe('text');
    expect(String(blocks[0].text)).toContain('note.txt');
  });
});
