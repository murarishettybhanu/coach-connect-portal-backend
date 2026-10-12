/**
 * What the admin inbox may send as a WhatsApp attachment, per Meta's Cloud API
 * media rules (types and size caps per kind). One upload ceiling for the route
 * keeps big files off the server's memory; documents are capped by it rather
 * than by Meta's 100 MB.
 */
export type OutboundMediaKind = 'image' | 'video' | 'audio' | 'document';

export const MAX_OUTBOUND_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_CAPTION = 1024;

const MB = 1024 * 1024;
const RULES: Record<OutboundMediaKind, { types: string[]; maxBytes: number }> =
  {
    image: { types: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
    video: { types: ['video/mp4', 'video/3gpp'], maxBytes: 16 * MB },
    audio: {
      types: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
      maxBytes: 16 * MB,
    },
    document: {
      types: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
      ],
      maxBytes: MAX_OUTBOUND_MEDIA_BYTES,
    },
  };

// Browsers send an empty or generic type for some files (CSV on Windows, .amr…).
const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  aac: 'audio/aac',
  amr: 'audio/amr',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
};

export type MediaCheck =
  | { ok: true; kind: OutboundMediaKind; mimeType: string; filename: string }
  | { ok: false; error: string };

/** The file's WhatsApp kind and normalised type, or why it can't be sent. */
export function checkOutboundMedia(file: {
  mimetype?: string;
  originalname?: string;
  size: number;
}): MediaCheck {
  const filename = sanitizeFilename(file.originalname || 'file');
  const ext = filename.includes('.')
    ? filename.split('.').pop()!.toLowerCase()
    : '';
  let mimeType = (file.mimetype || '').toLowerCase().split(';')[0].trim();
  if (!kindOf(mimeType) && BY_EXTENSION[ext]) mimeType = BY_EXTENSION[ext];
  const kind = kindOf(mimeType);
  if (!kind) {
    return {
      ok: false,
      error:
        'WhatsApp can’t send this file type. Send JPG/PNG images, MP4 video, MP3/AAC/OGG audio, or PDF, Word, Excel, PowerPoint, TXT or CSV documents.',
    };
  }
  if (file.size <= 0) return { ok: false, error: 'The file is empty.' };
  const max = RULES[kind].maxBytes;
  if (file.size > max) {
    return {
      ok: false,
      error: `${label(kind)} must be ${max / MB} MB or smaller for WhatsApp.`,
    };
  }
  return { ok: true, kind, mimeType, filename };
}

function kindOf(mimeType: string): OutboundMediaKind | null {
  for (const kind of Object.keys(RULES) as OutboundMediaKind[]) {
    if (RULES[kind].types.includes(mimeType)) return kind;
  }
  return null;
}

const label = (k: OutboundMediaKind) =>
  ({
    image: 'Images',
    video: 'Videos',
    audio: 'Audio files',
    document: 'Documents',
  })[k];

/** A filename safe to hand WhatsApp (shown to the customer) and to store. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const clean = base.replace(/[\u0000-\u001f"<>|*?:]/g, '').trim();
  return (clean || 'file').slice(0, 120);
}

/** Inbox preview line for a sent attachment. */
export function mediaPreview(
  kind: OutboundMediaKind,
  filename: string,
  caption?: string,
): string {
  const icon = { image: '📷', video: '🎬', audio: '🎵', document: '📎' }[kind];
  const what =
    kind === 'document'
      ? filename
      : { image: 'Photo', video: 'Video', audio: 'Audio' }[kind];
  return `${icon} ${caption?.trim() || what}`.slice(0, 200);
}
