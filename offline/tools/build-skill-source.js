/**
 * 把 battle-kit 里真正有的战法材料落成一份目录。
 * 不补类型、不补特性、不把名字配给武将。
 * 只有描述片段里逐字出现的战法名，才挂上那段原文。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = resolve(ROOT, '..', '..', '..', 'battle-kit', 'data');

function parseCsv(p) {
  const s = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i += 1; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const names = parseCsv(resolve(KIT, 'skill_names.csv')).slice(1).map((r) => r[0]).filter(Boolean);
const rates = parseCsv(resolve(KIT, 'damage_rates.csv')).slice(1).map((r) => ({
  fileId: r[0],
  index: Number(r[1]),
  valuePct: Number(r[2]),
  context: r[3] || '',
}));

const skills = names.map((name) => {
  const hits = rates.filter((r) => {
    const text = r.context || '';
    return text.includes(`【${name}】`) || text.includes(`「${name}」`) || text.startsWith(name);
  });
  return {
    name,
    skillType: null,
    description: null,
    trait: null,
    fragments: hits.map((h) => ({
      fileId: h.fileId,
      index: h.index,
      valuePct: h.valuePct,
      text: h.context,
    })),
  };
});

const out = {
  source: 'battle-kit/data/skill_names.csv + damage_rates.csv',
  missing: 'Tcfg_hero.skill_init、Tcfg_skill.description、skill_type、武将与战法的对应表，包内只有字段名，没有表值。',
  nameCount: skills.length,
  namedFragmentCount: skills.filter((s) => s.fragments.length > 0).length,
  skills,
};

const dest = resolve(ROOT, 'conf', 'campaign', 'skill-source.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`names ${out.nameCount} namedFragments ${out.namedFragmentCount}`);
