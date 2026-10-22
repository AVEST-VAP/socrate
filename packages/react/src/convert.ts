/*! Conversion vidéo par mediabunny 1.62.0, MPL-2.0, Vanilagy et contributeurs, source https://github.com/Vanilagy/mediabunny */
import { BlobSource, BufferTarget, Conversion, Input, type ConversionOptions, MP4, Mp4OutputFormat, Output, QTFF, Quality, WEBM, WebMOutputFormat, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { ATTACHMENT_TYPES } from '@socrate/contract';

// Conversion des vidéos dans le navigateur, chargée seulement quand une vidéo doit être convertie : MOV, ou MP4 et WebM au-delà de 50 Mio.

const LIMIT = ATTACHMENT_TYPES['video/mp4'].maxBytes;
const TARGET = LIMIT * 0.85;
const MAX_SECONDS = 15 * 60;
const AUDIO_BITRATE = 64_000;
// Une vidéo courte n'a pas besoin du débit que lui laisserait la limite, et les encodeurs refusent les débits extrêmes.
const MAX_BITRATE = 8_000_000;
// Bits par pixel et par image : un écran de texte fin reste lisible en 1080p à 15 images par seconde pour 10 minutes.
const BITS_PER_PIXEL = 0.01;
// Au-delà, un écran Retina de texte qui défile dépasse la consigne de deux à quatre fois chez les encodeurs mesurés ; à 1920 px le texte de 12 pt reste lisible.
const MAX_SIDE = 1920;
// Une image clé de texte fin pèse lourd : à 5 s d'intervalle, elles triplent le débit demandé aux encodeurs mesurés.
const KEY_FRAME_SECONDS = 20;
// Cadences qui divisent 30 et 60 images par seconde : une cadence irrégulière comme 8 coûte davantage qu'une plus haute.
const FRAME_RATES = [30, 15, 10, 6, 5];
// Avant ce progrès, l'en-tête et la première image clé faussent la taille projetée.
const PROJECT_AFTER = 0.1;
const UNREADABLE = 'ce navigateur ne sait pas lire cette vidéo.';
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const mib = (bytes: number) => Math.ceil(bytes / (1024 * 1024));

export type Converted = { blob: Blob; type: 'video/mp4' | 'video/webm' };
/** Refus dont le message complète « … n’est pas ajouté : » ; toute autre erreur est un échec de conversion. */
export class Refusal extends Error {}
type Settings = { bitrate: number; frameRate: number; scale: number };
type Pass = Converted | { projected: number; progress: number };

/**
 * Produit une vidéo MP4 (H.264/AAC), ou WebM (VP9/Opus) sans encodeur H.264, de 50 Mio au plus. Un MOV H.264/AAC qui tient dans la limite
 * est réencapsulé sans perte ; sinon le débit vise 85 % de la limite sur la durée, l'image est plafonnée à 1920 px et l'image et la cadence
 * baissent avec ce débit. Si la taille projetée dépasse la limite, une seule seconde passe repart avec débit et pixels par seconde réduits
 * du rapport observé. Rejette avec `Refusal` quand la vidéo ne peut pas être convertie ; `signal` annule la conversion en cours.
 */
export async function convertVideo(file: Blob, onProgress: (ratio: number) => void, signal: AbortSignal): Promise<Converted> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM] });
  try {
    const video = await input.getPrimaryVideoTrack().catch(() => null);
    if (!video || !(await video.canDecode())) throw new Refusal(UNREADABLE);
    const audio = await input.getPrimaryAudioTrack();
    const seconds = await input.computeDuration();
    if (!(seconds > 0)) throw new Refusal(UNREADABLE);
    if (seconds > MAX_SECONDS) throw new Refusal(`vidéo de ${Math.ceil(seconds / 60)} minutes, au-delà de 15 minutes : raccourcissez-la.`);
    const remux = file.size <= LIMIT && video.codec === 'avc' && (!audio || audio.codec === 'aac');
    const mp4 = remux || ((await canEncodeVideo('avc')) && (!audio || (await canEncodeAudio('aac'))));
    if (!mp4 && !((await canEncodeVideo('vp9')) && (!audio || (await canEncodeAudio('opus'))))) throw new Refusal('ce navigateur ne sait pas compresser de vidéo.');
    const type = mp4 ? 'video/mp4' : 'video/webm';
    const encode = async (s: Settings | null, progress: (ratio: number) => void): Promise<Pass> => {
      const target = new BufferTarget();
      let written = 0;
      target.on('write', ({ end }) => { written = Math.max(written, end); });
      // Sans « fast start », le MP4 s'écrit au fil de l'encodage et sa taille se projette ; le panneau lit toujours le fichier entier.
      const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(), target });
      const over = await run(input, output, s && {
        video: { codec: mp4 ? 'avc' : 'vp9', quality: new Quality({ bitrate: s.bitrate }), frameRate: s.frameRate, width: even(video.displayWidth * s.scale), height: even(video.displayHeight * s.scale), fit: 'contain', keyFrameInterval: KEY_FRAME_SECONDS, forceTranscode: true },
        audio: { codec: mp4 ? 'aac' : 'opus', quality: new Quality({ bitrate: AUDIO_BITRATE }), forceTranscode: true },
      }, () => written, progress, signal);
      return over ?? { blob: new Blob([target.buffer!], { type }), type };
    };
    const bitrate = Math.min(MAX_BITRATE, Math.floor((TARGET * 8) / seconds) - (audio ? AUDIO_BITRATE : 0));
    const frameRate = bitrate < 1_500_000 ? 15 : 30;
    const scale = Math.min(1, MAX_SIDE / Math.max(video.displayWidth, video.displayHeight), Math.sqrt(bitrate / (BITS_PER_PIXEL * frameRate * video.displayWidth * video.displayHeight)));
    const first = { bitrate, frameRate, scale };
    const pass = await encode(remux ? null : first, onProgress);
    if ('blob' in pass) return accept(pass);
    const done = pass.progress;
    const second = await encode(reduced(first, TARGET / pass.projected), (p) => onProgress((done + p) / (done + 1)));
    if ('blob' in second) return accept(second);
    throw new Refusal(tooHeavy(second.projected));
  } finally {
    input.dispose();
  }
}

const tooHeavy = (bytes: number) => `environ ${mib(bytes)} Mio même compressée, au-delà de 50 Mio : raccourcissez-la.`;
function accept(c: Converted): Converted {
  if (c.blob.size > LIMIT) throw new Refusal(tooHeavy(c.blob.size));
  return c;
}

/** Seconde passe : débit et pixels par seconde réduits du rapport observé, la cadence d'abord, l'image ensuite, qui garde le texte. */
function reduced(s: Settings, ratio: number): Settings {
  const wanted = s.frameRate * ratio;
  const frameRate = FRAME_RATES.find((f) => f <= wanted) ?? FRAME_RATES.at(-1)!;
  return { bitrate: Math.floor(s.bitrate * ratio), frameRate, scale: s.scale * Math.min(1, Math.sqrt(wanted / frameRate)) };
}

/**
 * Une passe de conversion. Avec `options`, dès `PROJECT_AFTER`, une taille projetée (octets écrits rapportés au progrès) au-delà de la
 * limite abandonne la passe et rend cette projection ; `null` quand la sortie est prête.
 */
async function run(input: Input, output: Output, options: Pick<ConversionOptions, 'video' | 'audio'> | null, written: () => number, onProgress: (ratio: number) => void, signal: AbortSignal) {
  const conversion = await Conversion.init({ input, output, tracks: 'primary', showWarnings: false, ...options });
  if (!conversion.isValid) throw new Refusal(UNREADABLE);
  let over: { projected: number; progress: number } | null = null;
  conversion.onProgress = (progress) => {
    onProgress(progress);
    if (!options || over || progress < PROJECT_AFTER || written() / progress <= LIMIT) return;
    over = { projected: written() / progress, progress };
    void conversion.cancel();
  };
  const cancel = () => void conversion.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await conversion.execute();
  } catch (e) {
    if (over && !signal.aborted) return over;
    throw e;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return null;
}
