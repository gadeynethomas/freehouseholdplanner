// Dutch UI strings, the default language. Other languages get a file with the same keys.
export const nl = {
  'app.title': 'Huishoudplanner',
  'app.version': 'Versie {version}',
  'home.welcome': 'Welkom',
  'home.empty': 'Hier verschijnen straks je huistaken en projecten.',
} as const;

export type MessageKey = keyof typeof nl;
