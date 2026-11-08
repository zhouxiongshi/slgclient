/**
 * 武将详情的两页：传记用已有短评，画像只统计这一局。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createWorld } from '../server/world.js';
import { dossierFor } from '../server/domain/dossier.js';

const cfg = loadConfig();

test('关羽有传记和画像，无名武将不编史', () => {
  const state = createWorld(cfg);
  const guan = dossierFor(state, { cfgId: 1, name: '关羽' });
  assert.match(guan.official, /河东/);
  assert.equal(guan.portrait.temper, '重诺，也认死理');
  assert.match(guan.portrait.fate, /尚未入营/);
  assert.equal(guan.portrait.owned, false);
  assert.equal(guan.portrait.battles, 0);

  const nobody = dossierFor(state, { cfgId: 9, name: '没有这个人' });
  assert.equal(nobody.official, '史书未在本局单独立传。');
  assert.equal(nobody.portrait.temper, '');
  assert.equal(nobody.portrait.fate, '');
});

test('主公在册时画像写出等级和兵力', () => {
  const state = createWorld(cfg);
  const doc = dossierFor(state, { cfgId: 880001, name: '主公' });
  assert.match(doc.official, /穿越者/);
  assert.equal(doc.portrait.owned, true);
  assert.equal(doc.portrait.level, 1);
  assert.equal(doc.portrait.soldiers, 800);
  assert.match(doc.portrait.voice, /账要自己算/);
});
