import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../conf/campaign/people.json');
let list = null;

function all() {
  if (!list) list = JSON.parse(readFileSync(FILE, 'utf8'));
  return list;
}

export function peopleById(id) {
  return all().find((p) => p.id === id) || null;
}

export function peopleByTitle(title) {
  return all().find((p) => p.title === title) || null;
}
