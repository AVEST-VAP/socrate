/** Alphabet des codes affichés : ni voyelle, ni 0, 1, 5 ou L, confondus à la lecture ou formant des mots. */
export const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ2346789';
export const USER_CODE_PATTERN = new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`);
/** Code saisi par la personne : casse, tiret et espaces ignorés. */
export const normalizeUserCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, '');
export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
