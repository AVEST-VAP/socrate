// Pièces jointes humaines d'un message, distinctes des captures techniques d'un fil. Module sans zod : le panneau l'importe seul.

const MIB = 1024 * 1024;

/** Formats admis et taille maximale de chaque pièce, en octets. Le service ne transcode pas : le type déclaré doit correspondre à la signature des octets. Le panneau convertit au préalable une vidéo MOV ou trop lourde. */
export const ATTACHMENT_TYPES = {
  'image/png': { media: 'image', maxBytes: 10 * MIB, label: 'PNG' },
  'image/jpeg': { media: 'image', maxBytes: 10 * MIB, label: 'JPEG' },
  'image/webp': { media: 'image', maxBytes: 10 * MIB, label: 'WebP' },
  'video/mp4': { media: 'video', maxBytes: 50 * MIB, label: 'MP4' },
  'video/webm': { media: 'video', maxBytes: 50 * MIB, label: 'WebM' },
} as const;
export type AttachmentType = keyof typeof ATTACHMENT_TYPES;
export const ATTACHMENT_TYPE_LIST = Object.keys(ATTACHMENT_TYPES) as AttachmentType[];
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_NAME = 200;
/** Octets lus en tête de pièce pour reconnaître son format. */
export const SIGNATURE_BYTES = 64;

export const isAttachmentType = (t: string): t is AttachmentType => Object.hasOwn(ATTACHMENT_TYPES, t);

const at = (b: Uint8Array, offset: number, ...bytes: number[]) => bytes.every((v, i) => b[offset + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Signature des premiers octets cohérente avec le type déclaré ; `head` porte au moins les `SIGNATURE_BYTES` premiers octets ou toute la pièce. */
export function signatureMatches(type: AttachmentType, head: Uint8Array): boolean {
  switch (type) {
    case 'image/png': return at(head, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg': return at(head, 0, 0xff, 0xd8, 0xff);
    case 'image/webp': return at(head, 0, ...ascii('RIFF')) && at(head, 8, ...ascii('WEBP'));
    case 'video/mp4': {
      if (head.length < 16 || !at(head, 4, ...ascii('ftyp'))) return false;
      const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
      // La boîte entière tient dans la tête commune ; isom seul décrit aussi des formats image.
      if (size < 16 || size > Math.min(head.length, SIGNATURE_BYTES) || size % 4 !== 0) return false;
      let mp4 = false;
      for (let offset = 8; offset < size; offset += 4) {
        if (offset === 12) continue;
        const brand = String.fromCharCode(...head.subarray(offset, offset + 4));
        if (offset >= 16 && brand === 'av01') continue;
        const video = ['mp41', 'mp42', 'avc1'].includes(brand);
        if (!video && !['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9'].includes(brand)) return false;
        mp4 ||= video;
      }
      return mp4;
    }
    case 'video/webm': {
      if (!at(head, 0, 0x1a, 0x45, 0xdf, 0xa3)) return false;
      const docType = ascii('webm');
      return head.subarray(0, SIGNATURE_BYTES).some((_, i) => at(head, i, ...docType));
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

// Contrôles C0/C1 et marques de direction : un nom de fichier ne réordonne ni ne masque le texte qui l'entoure.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Nom affiché d'une pièce, en texte seul : caractères invisibles retirés, espaces resserrés, 200 caractères au plus. */
export function safeName(raw: string): string {
  return Array.from(raw.replace(UNSAFE, '').replace(/\s+/g, ' ').trim()).slice(0, MAX_ATTACHMENT_NAME).join('').trim();
}
