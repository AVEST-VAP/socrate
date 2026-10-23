// Les règles du manifeste viennent du contrat, dont les messages sont en français : la CLI et le plugin les rendent en anglais.
const ENGLISH: [RegExp, string][] = [
  [/^texte requis$/, 'required text'],
  [/^au plus (\d+) caractères$/, 'at most $1 characters'],
  [/^identifiant en minuscules, chiffres et tirets$/, 'lowercase letters, digits and dashes'],
  [/^route relative commençant par \/$/, 'relative route starting with /'],
  [/^contexte d’instance en lettres, chiffres, tirets ou soulignés$/, 'instance context of letters, digits, dashes or underscores'],
  [/^langue BCP 47 simple, par exemple fr ou fr-FR$/, 'simple BCP 47 language, e.g. en or en-US'],
  [/^au moins une zone$/, 'at least one zone'],
  [/^au moins un fragment de zone$/, 'at least one zone file'],
  [/^zone en double : /, 'duplicate zone: '],
  [/^repère en double : /, 'duplicate marker: '],
  [/^texte à relire en double : /, 'duplicate wording: '],
  [/^zone inconnue : /, 'unknown zone: '],
  [/^donnée inconnue refusée$/, 'unknown key'],
  [/^référence non relative refusée : /, 'reference must be relative: '],
  [/^traversée hors du dossier refusée : /, 'reference leaves the folder: '],
  [/^seul un fragment JSON est accepté$/, 'only a JSON file is accepted'],
  [/^fichier référencé absent$/, 'referenced file not found'],
  [/^lien symbolique sortant refusé$/, 'symbolic link leaving the folder refused'],
  [/^lien symbolique refusé$/, 'symbolic link refused'],
  [/^JSON invalide : /, 'invalid JSON: '],
  [/^code exécutable refusé dans le dossier de revue$/, 'executable code refused in the review folder'],
  [/^fichier de données non référencé par index\.json$/, 'data file not referenced by index.json'],
];
const PATHS: Record<string, string> = { '(fichier)': '(file)', '(racine)': '(root)' };

export const english = (message: string): string => {
  const rule = ENGLISH.find(([french]) => french.test(message));
  return rule ? message.replace(rule[0], rule[1]) : message;
};

export type Issue = { file?: string; path: string; message: string };
export const describeIssue = (i: Issue): string => `  ${i.file ? `${i.file} ` : ''}${PATHS[i.path] ?? i.path}: ${english(i.message)}`;
