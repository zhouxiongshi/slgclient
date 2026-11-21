import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKILLS } from '../server/skills.js';

const MIRROR = JSON.parse(readFileSync(new URL('../conf/skill-mirror.json', import.meta.url), 'utf8'));
const MIRROR_IDS = new Set(MIRROR.skills.map((s) => Number(s.cfgId)));
const byId = (id) => {
  const s = SKILLS.find((x) => Number(x.cfgId) === Number(id));
  assert.ok(s, `找不到战法 ${id}`);
  return s;
};

/** 与渲染层一致：%n% 依次替换成等级数值，留下 %n%% 的尾部百分号。 */
function render(des, values) {
  let out = String(des || '');
  for (const v of values || []) out = out.replace('%n%', String(v));
  return out;
}

test('镜像战法的百分比占位符必须写成 %n%%（渲染后保留真实百分号）', () => {
  for (const s of SKILLS.filter((x) => MIRROR_IDS.has(Number(x.cfgId)))) {
    const raw = String(s.ui.des || '');
    assert.ok(!/(?<!%)%n%(?!%)/.test(raw), `${s.cfgId}:${s.name} 存在裸 %n%，渲染后会丢百分号`);
    const vals = s.ui.levels[9].effect_value;
    const shown = render(raw, vals);
    for (const v of vals) {
      assert.ok(shown.includes(`${v}%`), `${s.cfgId}:${s.name} 渲染后 ${v}% 缺失`);
    }
  }
});

test('内核有准备回合的战法必须在描述里写明回合数', () => {
  for (const s of SKILLS) {
    const n = Number(s.kernel?.prepare || 0);
    if (!n) continue;
    assert.match(s.ui.des || '', new RegExp(`${n}\\s*回合准备`), `${s.cfgId}:${s.name} 内核准备 ${n} 回合但描述未写`);
  }
});

/** 审计口径：主伤害/治疗效果的内核目标类型决定实际命中人数。 */
function kernelPeople(s) {
  const k = s.kernel || {};
  const effects = Array.isArray(k.effects) && k.effects.length ? k.effects : [k];
  const eff = effects.find((e) => /DAMAGE|HEAL/.test(String(e?.effect_type || ''))) || effects[0];
  const tt = String(eff?.target_type || '');
  if (!tt || tt === 'self' || tt === 'self_and_ally_single') return '';
  if (/single$|_one$/.test(tt)) return '单体';
  if (/_12$/.test(tt)) return '2人';
  return '3人';
}
function shownPeople(s) {
  const des = String(s.ui.des || '');
  if (/目标：普攻目标/.test(des)) return '单体';
  const m = des.match(/有效距离\s*\d+\s*·\s*(单体|\d\s*人)/);
  return m ? m[1].replace(/\s/g, '') : '';
}

test('描述中的目标人数取自内核主效果，不再沿用旧 UI 元数据', () => {
  for (const id of [10003, 10019, 920073, 920078, 920079, 920080]) {
    const s = byId(id);
    const want = kernelPeople(s);
    if (!want) continue;
    assert.equal(shownPeople(s), want, `${s.cfgId}:${s.name} 描述人数与内核不符`);
  }
});

test('万箭齐发逐槽渲染后百分比与目标人数都正确', () => {
  const s = byId(10003);
  const shown = render(s.ui.des, s.ui.levels[9].effect_value);
  assert.match(shown, /150%/);
  assert.match(shown, /50%/);
  assert.match(shown, /·\s*3\s*人/);
});
