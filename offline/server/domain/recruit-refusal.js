/**
 * 招募拒绝台词（2026-11-16）—— 把「婉拒」从游戏提示变成汉末情景里的人话。
 *
 * 用户要求：招募时武将会拒绝；拒绝理由要拟人、贴合汉末；谋略越高拒绝越有情商；
 * 莽夫、名将、名士按性格特征拒绝，别像读游戏数值。界面不再显示成功率/概率。
 *
 * 纪律：零依赖叶子（禁止 import），纯函数、确定性（同一人同一状态同一句），
 * 只读 generalByCfg 带出的 type / five / zheng，不改任何数值、不掷随机。
 * 文案均为本局原创、汉末口语白话，无外部作品原句。
 */

/** 按 type 字符串 + 史载五维把武将归入一种拒绝口吻。 */
export function personaOf(cfgId, row = {}) {
  const five = row.five || {};
  const zhi = Number(five.zhi) || Number(row.strategy) || 50;
  const wu = Number(five.wu) || Number(row.force) || 50;
  const tong = Number(five.tong) || Number(row.defense) || 50;
  const zheng = Number(five.zheng) || Number(row.politics) || 50;
  const t = String(row.type || '');
  const has = (s) => t.includes(s);

  // ① 显式性格标签优先（type 是权威人设，不被数值覆盖）
  if (has('莽') || has('猛将')) return 'mangfu';
  if (has('谋士') || has('战略家') || has('政治家') || has('权臣')) return 'mouchen';
  if (has('名士') || has('文臣') || has('名臣') || has('能臣') || has('忠臣')
    || has('丞相') || has('经学') || has('学者')) return 'mingshi';
  if (has('君主') || has('军阀') || has('宗室') || has('渠帅') || has('首领')) return 'zhuhou';
  if (has('名将') || has('将领') || has('边吏') || has('巾帼') || has('女将')) return 'mingjiang';
  // ② 无明确标签时按五维推断
  if (wu >= 90 && zhi < 60) return 'mangfu';
  if (zhi >= 88 && zheng >= 70) return 'mouchen';
  if (zheng >= 85 && zhi >= 75) return 'mingshi';
  if (tong >= 80) return 'mingjiang';
  return zhi >= wu ? 'mingshi' : 'mangfu';
}

/** 每种口吻的拒绝台词；index 由 cfgId 与好感确定，保证同态同句、不同人不同句。 */
const LINES = {
  // 莽夫：直来直去，认力气不认虚礼；情商低，话冲但不失汉末草莽气
  mangfu: [
    '某家不认什么延揽，你那点金子自家收着。真要招某，阵上拿刀说话！',
    '呸！某跟着你是图你那几两金？少绕弯子，不干！',
    '某这把刀只认吃得饱的主儿。你拿什么养某？说不出来就别费话。',
  ],
  // 名将：重名节、讲去就，话留三分，职业军人语气
  mingjiang: [
    '某受先主厚遇，未可背弃。将军美意，某记下了，容后图之。',
    '某麾下尚有旧部要安置，此时易主，于义不合。将军海涵。',
    '将军正当用人，某却不敢轻许——名节这事，一旦失了便再也捡不回。',
  ],
  // 名士：文雅含蓄，引古论今，情商最高，拒绝得体贴周全
  mingshi: [
    '仆久慕将军之风，然乱世立身，不可不慎。且待时局稍定，再议出处未晚。',
    '将军礼贤下士，仆心感之。只恐才薄德浅，不堪驱使，反误将军大事。',
    '山野之人，惯于简居。将军帐下人才济济，仆愿以闲身旁观盛业。',
  ],
  // 谋士：分析局势式拒绝，情商高，话里有话、留有余地
  mouchen: [
    '将军欲图天下，某岂不愿效力的？只是时机未至，某观局势尚有未明处，容某再观望。',
    '某非不受命，实因所虑者大。若仓促就席，恐见识短浅，反累将军远略。',
    '将军之志，某略知一二。某有一计未成，待尘埃落定，自当登门请见。',
  ],
  // 诸侯/宗室/军阀：自有基业，不肯屈居人下
  zhuhou: [
    '某亦有一方土地要守，岂能弃之从人？将军好意，某心领了。',
    '某与将军各为其主，道上相逢，以礼相待便好。延揽之事，休要再提。',
    '某生来不肯居人之下。若要某低头，倒不如阵前一见高下。',
  ],
};

/** 同一人设里「谋略高」的更圆融版本：谋略越高，拒绝越讲分寸、越留余地。 */
const HIGH_EQ_LINE = {
  mangfu: '某虽是粗人，也知将军好意。只是某认死理：不给弟兄们一个交代，某不便易主。',
  mingjiang: '将军知遇，某岂敢轻弃？只是去就有道，某须先安顿旧部，方不负将军这份看重。',
  mingshi: '将军厚礼，仆愧不敢当。乱世出处，仆愿先观将军之政，若果有利民之实，再拜麾下未迟。',
  mouchen: '某观将军用人之诚，心甚感之。正因看重，才不敢以浅见妄许——待某胸中成算，必当登门效力。',
  zhuhou: '将军几番厚意，某非不感。只是各守疆土、各安其民，方是眼下正道；他日若有幸，再叙相逢。',
};

/** 反复三顾后的一句软话（情商随谋略上浮，莽夫始终直白）。 */
const RETURN_LINE = {
  mangfu: '又是你。某说了不干就是不干——不过你这人倒是条汉子，改日请你喝酒。',
  mingjiang: '将军连番礼遇，某实感愧。只是旧义未了，仍难从命，望将军见谅。',
  mingshi: '将军三顾，仆何德何能。若再相逼，倒显得仆不识抬举了——容仆徐徐图之。',
  mouchen: '将军数度相邀，某岂不知？正因看重，才不敢轻易许诺，恐负将军所望。',
  zhuhou: '将军几番来意，某已知晓。各守其土罢了，不必再费口舌。',
};

function pickIndex(cfgId, favor) {
  const n = (Math.abs(Number(cfgId) || 0) + Math.max(0, Number(favor) || 0) * 3) % 3;
  return n;
}

/**
 * 生成拒绝台词。
 * @param cfg {object} generalByCfg 行（含 type/five）
 * @param opt {cfgId, favor} 被拒次数（三顾好感）
 * @returns { text, persona, name }  name 为称谓（某将/某生，仅用于口吻标注，不进台词）
 */
export function refusalLine(cfg = {}, opt = {}) {
  const persona = personaOf(opt.cfgId, cfg);
  const idx = pickIndex(opt.cfgId, opt.favor);
  const favor = Math.max(0, Number(opt.favor) || 0);
  const lines = LINES[persona] || LINES.mingjiang;
  const zhi = Number(cfg?.five?.zhi) || Number(cfg?.strategy) || 50;
  let text;
  if (favor >= 2) text = RETURN_LINE[persona];
  /* ★ 谋略越高越有情商：同一人设里谋略高者改用圆融版本，拒绝更讲分寸。 */
  else if (zhi >= 78 && HIGH_EQ_LINE[persona]) text = HIGH_EQ_LINE[persona];
  else text = lines[idx % lines.length];
  return { text, persona, favor };
}
