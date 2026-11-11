import { nl, type MessageKey } from './messages/nl.ts';

export type { MessageKey };

/** Values for the `{name}` placeholders in a message. */
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fills in a message's placeholders. A placeholder without a value stays visible as `{name}`,
 * so a missing value shows up in the UI instead of silently disappearing.
 */
export function format(template: string, params: MessageParams = {}): string {
  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** The UI text for a key, in the app's language (Dutch for now). */
export function t(key: MessageKey, params?: MessageParams): string {
  return format(nl[key], params);
}
