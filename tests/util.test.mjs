// Unit tests for lib/util.js — same cases as the Node version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNumber, isWhatsappCdn } from '../lib/util.js';

test('normalizeNumber accepts +92, 00-prefix and plain digits', () => {
  assert.equal(normalizeNumber('+92 300 1234567'), '923001234567');
  assert.equal(normalizeNumber('00923001234567'), '923001234567');
  assert.equal(normalizeNumber('923001234567'), '923001234567');
  assert.equal(normalizeNumber('03001234567'), '03001234567');
});

test('normalizeNumber rejects junk', () => {
  assert.equal(normalizeNumber('abc'), null);
  assert.equal(normalizeNumber('123'), null);              // too short
  assert.equal(normalizeNumber('1234567890123456'), null); // too long
  assert.equal(normalizeNumber(''), null);
  assert.equal(normalizeNumber(null), null);
});

test('isWhatsappCdn only allows WhatsApp/Facebook CDN hosts', () => {
  assert.equal(isWhatsappCdn('https://pps.whatsapp.net/v/t61.abc.jpg'), true);
  assert.equal(isWhatsappCdn('https://scontent.fbcdn.net/v/abc.jpg'), true);
  assert.equal(isWhatsappCdn('https://evil.example.com/x.jpg'), false);
  assert.equal(isWhatsappCdn('not a url'), false);
  assert.equal(isWhatsappCdn('https://whatsapp.net.evil.com/x.jpg'), false);
});
