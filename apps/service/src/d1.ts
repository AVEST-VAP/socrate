import { HttpError } from './http.ts';

export const isConstraintViolation = (e: unknown) => /UNIQUE|PRIMARY KEY|constraint/i.test(String(e));

export const uncertain = (message = 'écriture non confirmée, réessayer avec la même clé') => new HttpError(503, 'persistence_uncertain', message, true);
