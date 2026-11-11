import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format, t } from './i18n.ts';

test('format fills in every placeholder', () => {
  assert.equal(format('{a} en {b}, nog eens {a}', { a: 'x', b: 2 }), 'x en 2, nog eens x');
});

test('format keeps a placeholder without a value visible', () => {
  assert.equal(format('Versie {version}'), 'Versie {version}');
});

test('format leaves text without placeholders unchanged', () => {
  assert.equal(format(''), '');
  assert.equal(format('Welkom', { unused: 'x' }), 'Welkom');
});

test('format writes zero and empty values', () => {
  assert.equal(format('{n} taken', { n: 0 }), '0 taken');
  assert.equal(format('[{s}]', { s: '' }), '[]');
});

test('t looks up the Dutch text', () => {
  assert.equal(t('app.version', { version: '0.1.0' }), 'Versie 0.1.0');
});
