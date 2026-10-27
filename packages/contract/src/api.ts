import { z } from 'zod';
import { manifestSchema, stableId } from './manifest.ts';
import { isSanitizedHtml } from './html.ts';
import { ATTACHMENT_TYPES, ATTACHMENT_TYPE_LIST, MAX_ATTACHMENTS, safeName, type AttachmentType } from './attachments.ts';

export const CAPABILITIES = ['thread.participate', 'thread.moderate', 'deployment.import', 'review.read', 'review.archive'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const capabilitySchema = z.enum(CAPABILITIES);

export type ErrorCode =
  | 'unauthenticated' | 'assertion_invalid' | 'assertion_replayed' | 'session_expired'
  | 'origin_not_registered' | 'forbidden' | 'not_found' | 'invalid_request' | 'invalid_manifest'
  | 'immutable_deployment' | 'idempotency_conflict' | 'state_conflict' | 'review_inactive' | 'persistence_uncertain'
  | 'not_ready' | 'schema_incompatible' | 'misconfigured'
  | 'capture_mismatch' | 'capture_missing' | 'reservation_lost' | 'revision_changed' | 'resync_required' | 'maintenance'
  | 'attachment_rejected' | 'attachment_missing'
  | 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant' | 'rate_limited';

export type ApiError = { code: ErrorCode; message: string; requestId: string; retryable: boolean; issues?: { file?: string; path: string; message: string }[] };

export const deploymentImportSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  buildId: z.string().min(1).max(64),
  url: z.string().url(),
  manifest: manifestSchema,
});
export type DeploymentImport = z.infer<typeof deploymentImportSchema>;

export const sessionRequestSchema = z.strictObject({ assertion: z.string().min(1) });

const proposalText = z.string().trim().min(1, 'texte vide').max(1000);
/** Révision affichée quand la relectrice a rédigé la proposition : le service refuse toute autre révision au lieu de réinterpréter l'original. */
const observedRevision = z.string().regex(/^[0-9a-f]{64}$/);
/** Depuis la revue regroupée : un texte préparé identifié, sans capture. */
export const listProposalSchema = z.strictObject({ wordingId: stableId, replacement: proposalText, revisionId: observedRevision });
export type ListProposal = z.infer<typeof listProposalSchema>;
/** Depuis la page : la cible porte seule l'extrait et le rattachement éventuel, la proposition seulement le remplacement. */
export const pageProposalSchema = z.strictObject({ replacement: proposalText, revisionId: observedRevision });
export type PageProposalInput = z.infer<typeof pageProposalSchema>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Pièce jointe déclarée avant ses octets : nom en texte sûr, type admis, taille dans la borne de son type, empreinte des octets. */
export const attachmentMetaSchema = z.strictObject({
  name: z.string().min(1).max(800).refine((n) => n === safeName(n) && n.length > 0, 'nom de fichier non normalisé (caractères de contrôle, espaces ou longueur)'),
  contentType: z.enum(ATTACHMENT_TYPE_LIST as [AttachmentType, ...AttachmentType[]]),
  size: z.number().int().positive(),
  sha256,
}).refine((a) => a.size <= ATTACHMENT_TYPES[a.contentType].maxBytes, { message: 'pièce trop volumineuse pour son type', path: ['size'] });
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;
/** Pièces d'un message, dans l'ordre d'affichage. Absent ou vide : message sans pièce, de forme antérieure. */
const attachmentList = z.array(attachmentMetaSchema).max(MAX_ATTACHMENTS, `${MAX_ATTACHMENTS} pièces au plus par message`);

/** Opération qui rattachera les pièces réservées : la même clé d'idempotence et le même acteur la désignent. */
export const ATTACHMENT_OPERATIONS = ['thread.create', 'thread.targeted', 'message.create'] as const;
export type AttachmentOperation = (typeof ATTACHMENT_OPERATIONS)[number];
export const attachmentReservationSchema = z.strictObject({
  operation: z.enum(ATTACHMENT_OPERATIONS),
  attachments: attachmentList.min(1, 'au moins une pièce'),
});

const messageBody = z.string().trim().max(16_000);
/** Un message porte un texte, des pièces, ou les deux : jamais ni l'un ni l'autre. */
const withContent = <T extends { body: string; attachments?: AttachmentMeta[] }>(m: T, ctx: z.RefinementCtx) => {
  if (!m.body && !m.attachments?.length) ctx.addIssue({ code: 'custom', message: 'message vide', path: ['body'] });
};

export const newThreadSchema = z.strictObject({
  kind: z.literal('global'),
  body: messageBody,
  proposal: listProposalSchema.optional(),
  attachments: attachmentList.optional(),
}).superRefine(withContent);
export const MAX_CAPTURE_BYTES = 12 * 1024 * 1024;

const finite = z.number().finite();
export const targetSchema = z.strictObject({
  url: z.string().url().max(2048),
  route: z.string().min(1).max(512),
  /** Chemin de frame depuis l'onglet : sélecteurs des iframes traversées, vide pour le document principal, absent avant la V1 vue scindée. */
  frame: z.array(z.string().min(1).max(300)).max(1).optional(),
  /** Route de l'onglet hôte pour une cible d'iframe ; absente des charges antérieures, jamais devinée ni ajoutée par défaut. */
  hostRoute: z.string().min(1).max(512).optional(),
  /** Texte préparé déclaré par l'hôte sur l'élément ciblé (`data-socrate-wording`), absent pour un texte libre. */
  wording: stableId.optional(),
  rect: z.strictObject({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() }),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), devicePixelRatio: finite.positive(), scrollX: finite, scrollY: finite }),
  role: z.string().max(64),
  text: z.string().max(500),
  selector: z.string().max(300),
  html: z.string().max(4000).refine(isSanitizedHtml, 'extrait HTML non nettoyé'),
  /** Ancêtre proche assaini en entier et indices d'enfants jusqu'à la cible, qui la distinguent de ses semblables ; absent des charges antérieures et des cibles non distinguées. */
  context: z.strictObject({
    html: z.string().min(1).max(1000).refine(isSanitizedHtml, 'contexte HTML non nettoyé'),
    path: z.array(z.number().int().nonnegative().max(1000)).min(1).max(3),
  }).optional(),
  /** Fenêtre ou panneau modal qui contenait la cible (`dialog`, rôle `dialog` ou `alertdialog`, `aria-modal`), avec son libellé lisible s'il en a un ; absent hors d'une fenêtre et des charges antérieures. */
  container: z.strictObject({ label: z.string().max(80).regex(/^[^\p{C}]*$/u).optional() }).optional(),
});
export type Target = z.infer<typeof targetSchema>;

export const imageMetaSchema = z.strictObject({
  contentType: z.literal('image/png'),
  size: z.number().int().positive().max(MAX_CAPTURE_BYTES),
  sha256,
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
});
export type ImageMeta = z.infer<typeof imageMetaSchema>;

export const newTargetedThreadSchema = z.strictObject({
  kind: z.literal('targeted'),
  body: messageBody,
  target: targetSchema,
  image: imageMetaSchema,
  proposal: pageProposalSchema.optional(),
  attachments: attachmentList.optional(),
}).superRefine(withContent);
export type NewTargetedThread = z.infer<typeof newTargetedThreadSchema>;
export const captureCommitSchema = z.strictObject({ attempt: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });

/** `available` : l'image validée se télécharge sur `GET …/captures/{captureId}`, jamais dans le JSON. */
export type Capture = ImageMeta & { captureId: string; status: 'available' };
export type Reservation = { status: 'reserved'; captureId: string; attempt: string; uploaded: boolean; expiresAt: string };

export const newMessageSchema = z.strictObject({ body: messageBody, attachments: attachmentList.optional() }).superRefine(withContent);
export const stateChangeSchema = z.strictObject({ state: z.enum(['open', 'resolved']), expectedVersion: z.number().int().nonnegative() });
/** Commit qui résout un fil : hexadécimal abrégé ou complet. */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, 'commit hexadécimal de 7 à 40 caractères');
const transitionMessage = z.string().trim().min(1, 'message requis').max(16_000);
/** Résolution en une opération : le message est obligatoire, le commit facultatif. */
export const resolveSchema = z.strictObject({ message: transitionMessage, commit: commitShaSchema.optional() });
export const reopenSchema = z.strictObject({ message: transitionMessage });

/** Nom d'agent ou de machine : texte imprimable sur une ligne, sans caractère de contrôle. */
const printable = (max: number) => z.string().trim().min(1, 'texte requis').max(max, `au plus ${max} caractères`).regex(/^[^\p{C}]+$/u, 'caractères imprimables seulement');
export const deviceStartSchema = z.strictObject({ projectId: z.string().min(1).max(64), agent: printable(32), machine: printable(64) });
export const deviceTokenRequestSchema = z.strictObject({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'code d’appareil invalide') });

export type Exploring = { account: string; organisation: string | null } | null;
export type Actor = { key: string; displayName: string };

/** Réponse au démarrage d'une autorisation par code : `deviceCode` reste dans l'outil, `userCode` est affiché à la personne. */
export type DeviceStart = { deviceCode: string; userCode: string; expiresIn: number; interval: number };
/** Détails lus par le panneau avant la décision. */
export type DeviceDetails = { userCode: string; projectId: string; agent: string; machine: string; createdAt: string; expiresAt: string };
/** Jeton délégué remis une seule fois à l'échange. */
export type AgentGrant = { accessToken: string; tokenType: 'Bearer'; tokenId: string; projectId: string; agent: string; machine: string; actor: Actor; capabilities: Capability[]; expiresAt: string };
/** Jeton délégué listé dans le panneau, sans le secret. */
export type AgentToken = { tokenId: string; agent: string; machine: string; capabilities: Capability[]; createdAt: string; lastUsedAt: string | null; expiresAt: string };

export type Session = {
  sessionToken: string;
  expiresAt: string;
  actor: Actor;
  exploring: Exploring;
  capabilities: Capability[];
};

/** `archived` reste lisible jusqu'à sa date de purge ; `purging` attend la fin des écritures tardives ; `purged` ne garde que cette ligne. */
export type ReviewState = 'active' | 'archived' | 'purging' | 'purged';
export type Review = { projectId: string; reviewKey: string; state: ReviewState };
export type Revision = { revisionId: string; manifest: z.infer<typeof manifestSchema>; createdAt: string };
export type Deployment = { deploymentId: string; revisionId: string; commit: string; buildId: string; url: string; origin: string; createdAt: string };

export type WordingRef = { id: string; key: string | null; locale: string; variant: string | null };
/** Écart entre l'original figé et le texte préparé de la révision de référence de la lecture ; nul pour un texte libre. */
export type WordingDrift =
  | { status: 'current' | 'removed'; revisionId: string }
  | { status: 'changed'; revisionId: string; currentSource: string };
export type Proposal = { original: string; replacement: string; sourceRevisionId: string; wording: WordingRef | null; drift: WordingDrift | null };

/** Pièce rattachée à son message ; ses octets se téléchargent sur `GET …/attachments/{attachmentId}`, jamais dans le JSON ni par lien public. */
export type Attachment = AttachmentMeta & { attachmentId: string };
/** Réservation des pièces d'une opération, dans l'ordre déclaré ; `uploaded` vaut aussi pour une pièce déjà rattachée par cette opération. */
export type AttachmentReservation = { items: Array<{ attachmentId: string; uploaded: boolean }>; expiresAt: string };
/**
 * Changement d'état porté par un message : `commit` et `deploymentId` (dernier déploiement non révoqué au moment de l'écriture) pour une résolution.
 * Calculés à la lecture pour une résolution avec commit, absents d'un service antérieur, `null` sinon :
 * `liveSince`, date du premier déploiement non révoqué de la revue qui porte ce commit (préfixe dans un sens ou l'autre) ;
 * `liveState`, `live` si ce déploiement existe, `pending` si aucun déploiement non révoqué n'a été créé depuis la résolution, `unknown` sinon
 * (un build postérieur peut contenir le correctif sous un autre commit).
 */
export type Transition = { state: 'resolved' | 'open'; commit: string | null; deploymentId: string | null; liveSince?: string | null; liveState?: 'live' | 'pending' | 'unknown' | null };
/**
 * `body` vide seulement pour un message fait de pièces. `attachments` vide pour un message sans pièce, dont tous ceux d’avant les pièces jointes.
 * `via` nomme l'agent qui a écrit au nom de l'auteur, `null` pour un message écrit dans le navigateur.
 */
export type Message = { messageId: string; threadId: string; seq: number; author: Actor; exploring: Exploring; body: string; attachments: Attachment[]; via: string | null; transition: Transition | null; createdAt: string };
export type Thread = {
  threadId: string; kind: 'global' | 'targeted'; state: 'open' | 'resolved'; version: number;
  revisionId: string; deploymentId: string; author: Actor; createdAt: string; updatedAt: string;
  target: Target | null; capture: Capture | null; proposal: Proposal | null;
};
export type ThreadWithMessages = Thread & { messages: Message[] };

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export const MAX_PAGE_SIZE = 100;
const pageSize = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20);
const instant = z.string().datetime({ offset: false });
const END_OF_9999_MS = Date.UTC(10000, 0, 1);
/**
 * Borne d'un filtre ramenée au grain des horodatages stockés, la milliseconde. Une fraction résiduelle non nulle passe
 * à la milliseconde suivante : sur cette grille, `>=` et `<` restent exacts. Le filtre rendu garde la borne d'origine.
 */
export function millisecondBound(value: string): string {
  const residue = /\.\d{3}(\d+)Z$/.exec(value)?.[1] ?? '';
  const ms = Date.parse(value.replace(/(\.\d{3})\d+Z$/, '$1Z')) + (/[1-9]/.test(residue) ? 1 : 0);
  // `toISOString` écrirait l'an 10000 `+010000`, classé avant les années à quatre chiffres ; `24:00` est le même instant, ordonné.
  return ms === END_OF_9999_MS ? '9999-12-31T24:00:00.000Z' : new Date(ms).toISOString();
}
/** Filtres figés au premier appel d'une liste ; `updatedSince` inclusif, `updatedBefore` exclusif. */
export const threadFilterSchema = z.strictObject({
  state: z.enum(['open', 'resolved']).optional(),
  updatedSince: instant.optional(),
  updatedBefore: instant.optional(),
});
export type ThreadFilter = z.infer<typeof threadFilterSchema>;
export const CURSOR_PATTERN = /^l1\.[0-9a-f]{32}\.[0-9]{1,9}$/;
/** `c2.<epoch>.<portée>.<seq>`, portée liée au projet et à la revue. `c1.<epoch>.<seq>`, sans portée, reste reconnu pour exiger une resynchronisation. */
export const MARKER_PATTERN = /^(?:c2\.[0-9a-f]{32}\.[0-9a-f]{32}|c1\.[0-9a-f]{32})\.[0-9]{1,15}$/;
/** Première page : filtres seuls ; pages suivantes : curseur seul, qui porte les filtres du premier appel. */
export const threadListQuerySchema = z.union([
  z.strictObject({ cursor: z.string().regex(CURSOR_PATTERN, 'curseur invalide'), limit: pageSize }),
  threadFilterSchema.extend({ limit: pageSize }),
]);
export const changesQuerySchema = z.strictObject({ since: z.string().regex(MARKER_PATTERN, 'marqueur invalide'), limit: pageSize });

export type ThreadPage = {
  items: ThreadWithMessages[];
  /** Curseur de la page suivante, `null` à la dernière page. */
  nextCursor: string | null;
  /** Marqueur du journal au premier appel : `GET …/changes?since=` rend tout fil modifié pendant ou après le parcours. */
  changesSince: string;
  filter: ThreadFilter;
  total: number;
  expiresAt: string;
};
export type ChangesPage = { items: ThreadWithMessages[]; next: string; more: boolean };
/** Journal d'un passage de purge manuelle : `complete` n'est vrai que si l'état durable final ne garde aucune revue expirée non purgée. */
export type PurgeEntry = { reviewKey: string; action: 'deleted' | 'kept' | 'waiting' | 'purged'; resource: string; detail: string };
export type PurgeReport = { runId: string; at: string; mode: 'manuelle'; planification: 'non déployée'; complete: boolean; entries: PurgeEntry[] };
export type ReviewSummary = Review & { createdAt: string; archivedAt: string | null; purgeAfter: string | null; purgedAt: string | null; latestDeployment: { deploymentId: string; revisionId: string; url: string; createdAt: string } | null };
