/**
 * 命令层。战斗和协议不在这里写悼词；这里只把已经发生的事交给履历。
 */
import { recordDeath } from './domain/chronicle.js';
import { peopleById } from './domain/people.js';

export function noteIfGeneralDown(state, ctx, army) {
  const id = state.campaign?.spearmanId;
  if (!id || state.campaign.spearmanDead) return null;
  const idx = (army?.generals || []).findIndex((gid) => gid === id);
  if (idx < 0) return null;
  if ((army.soldiers?.[idx] || 0) > 0) return null;
  state.campaign.spearmanDead = true;
  const who = peopleById('tunzhang') || { title: '屯长', official: '史无此人', voice: '' };
  const row = recordDeath(state, {
    generalId: id,
    name: who.title,
    official: who.official,
    played: `第 ${state.clock?.day || 1} 日兵尽。${who.voice}`,
  });
  const cm = {
    rid: 0,
    nickName: '履历',
    type: 0,
    msg: `正史：${row.official}。本局：${row.played}`,
    time: Date.now(),
  };
  state.chat = state.chat || [];
  state.chat.push(cm);
  ctx?.push?.('chat.push', cm);
  return row;
}
