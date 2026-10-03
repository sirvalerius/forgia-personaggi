// Rules engine: pure functions, no DOM. compute(char, data) -> derived sheet.
// Re-implements MPMB's Acrobat automation (AbilityScores.js, Functions*.js) on the declarative parts of its data:
// every active object (race, background, class/subclass features up to the level, chosen options, feats) contributes
// "effects" (proficiencies, saves, AC, speeds, senses, resistances, resources, actions, bonus spells…).
(function (root) {
  const ABIL = ['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'];
  const ABIL_FULL = ['Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma'];
  const SKILLS = [
    ['Acrobatics', 1, 'Acr'], ['Animal Handling', 4, 'Ani'], ['Arcana', 3, 'Arc'], ['Athletics', 0, 'Ath'], ['Deception', 5, 'Dec'], ['History', 3, 'His'],
    ['Insight', 4, 'Ins'], ['Intimidation', 5, 'Inti'], ['Investigation', 3, 'Inv'], ['Medicine', 4, 'Med'], ['Nature', 3, 'Nat'], ['Perception', 4, 'Perc'],
    ['Performance', 5, 'Perf'], ['Persuasion', 5, 'Pers'], ['Religion', 3, 'Rel'], ['Sleight of Hand', 1, 'Sle'], ['Stealth', 1, 'Ste'], ['Survival', 4, 'Sur'],
  ].map(([name, ab, abbr]) => ({ name, ab, abbr }));
  const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
  const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  // Spell slots by caster level (PHB multiclass table), index = caster level
  const SLOTS = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
    [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
    [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
  const PACT_SLOTS = [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4];
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const FIRSTCOL = { oncelr: '1/riposo lungo', oncesr: '1/riposo breve', atwill: 'a volontà', markedbox: 'sempre preparato', 'oncelr+markedbox': '1/riposo lungo' };

  const mod = s => Math.floor((s - 10) / 2);
  const sign = n => (n >= 0 ? '+' : '') + n;
  const profBonus = lvl => Math.ceil(lvl / 4) + 1;
  const pointBuyCost = scores => scores.reduce((t, s) => t + (POINT_COST[s] ?? NaN), 0);
  const atLevel = (v, lvl) => Array.isArray(v) ? v[Math.min(lvl, v.length) - 1] : v;
  const abIndex = a => { const i = ABIL.indexOf(String(a || '').slice(0, 3).replace(/^\w/, x => x.toUpperCase())); return i; };

  // "Choose 2: A, B, or C." / "Choose two from A, B, and C" / "Choose any three skills" -> {count, options|null}
  function parseChoice(txt) {
    if (!txt) return { count: 0, options: null };
    const m = /choose (?:any )?(\d+|one|two|three|four|five|six)/i.exec(txt) || /proficiency (?:with|in) (?:any )?(\d+|one|two|three|four)/i.exec(txt);
    const count = m ? (+m[1] || NUM[m[1].toLowerCase()]) : 0;
    if (/any/i.test(txt) && !/:/.test(txt)) return { count, options: null };
    const list = txt.replace(/^.*?(?::|from)\s*/i, '').replace(/\.$/, '');
    const options = list.split(/,\s*(?:and |or )?|\s+(?:and|or)\s+/).map(s => s.trim()).filter(s => SKILLS.some(k => k.name === s));
    return { count, options: options.length ? options : null };
  }

  // 2024 background: "+2 to one and +1 to another -or- +1 to all three: Intelligence, Wisdom, and Charisma" -> [3,4,5]
  function backgroundAbilities(scorestxt) {
    if (!scorestxt) return [];
    const after = scorestxt.split(':').pop();
    return ABIL_FULL.map((n, i) => after.includes(n) ? i : -1).filter(i => i >= 0);
  }

  // MPMB descriptions are either a string or an array indexed by level-1; strip its light markup
  function descAt(desc, level) {
    const d = Array.isArray(desc) ? (desc[level - 1] ?? desc[desc.length - 1] ?? '') : (desc || '');
    return String(d).replace(/^\s*\n/, '').replace(/#\[[^\]]*\]#/g, '').trim();
  }

  // MPMB modifier expressions: 1, "Cha", "prof", "max(Cha|1)", "Prof/2", "Con+1"… -> number (0 if not understood)
  function evalMod(expr, m, pb) {
    if (typeof expr === 'number') return expr;
    let s = String(expr ?? '').trim();
    if (!s) return 0;
    s = s.replace(/\b(Str|Dex|Con|Int|Wis|Cha)\b/gi, k => `(${m[abIndex(k)]})`).replace(/\bprof(iciency bonus)?\b/gi, `(${pb})`)
      .replace(/\bmax\(/gi, 'Math.max(').replace(/\bmin\(/gi, 'Math.min(').replace(/\|/g, ',');
    if (!/^[\d\s+\-*/().,]*$/.test(s.replace(/Math\.(max|min)/g, ''))) return 0;
    try { const v = Function('return Math.floor(' + s + ')')(); return Number.isFinite(v) ? v : 0; } catch { return 0; }
  }

  function raceOf(c, D) {
    const race = D.races[c.race];
    const sub = race && c.subrace ? D.subraces[c.race + '-' + c.subrace] : null;
    return { race, sub };
  }
  const findOpt = (list, val) => val ? (list || []).find(o => o.key === String(val).toLowerCase() || o.name === val) : undefined;

  // ---- Class levels (multiclass): c.levels[i] = class of character level i+1; level 1 is always c.cls ----
  // -> [{key, cls, level, subKey, subcls}] in order of first appearance
  function classLevels(c, D) {
    const lvl = Math.max(1, Math.min(20, +c.level || 1));
    const seq = [];
    for (let i = 0; i < lvl; i++) seq.push(i === 0 ? c.cls : (D.classes[c.levels?.[i]] ? c.levels[i] : seq[i - 1]));
    const out = [];
    seq.forEach(k => { const e = out.find(x => x.key === k); if (e) e.level++; else if (D.classes[k]) out.push({ key: k, cls: D.classes[k], level: 1 }); });
    out.forEach(e => {
      e.subKey = c.subclasses?.[e.key] ?? (e.key === c.cls ? c.subclass : '') ?? '';
      e.subcls = e.level >= (e.cls.subclassLevel || 3) ? D.subclasses[e.subKey] || null : null;
    });
    return { seq, entries: out };
  }
  // feature choices are stored per owner ("cls:wizard|arcane recovery"); older characters used the bare feature key
  const qkey = (owner, key) => owner + '|' + key;
  const choiceOf = (c, owner, key, legacy) => (c.featureChoices || {})[qkey(owner, key)] ?? (legacy ? (c.featureChoices || {})[key] : undefined);
  const extraOf = (c, owner, key, legacy) => (c.extraChoices || {})[qkey(owner, key)] ?? (legacy ? (c.extraChoices || {})[key] : undefined) ?? [];

  // ---- Feats the character has: origin (2024 species / 2014 variant human), background (2024), ASI slots per class, extra ----
  function featSlots(c, D, entries) {
    const slots = [];
    const { race, sub } = raceOf(c, D);
    const bg = D.backgrounds[c.background];
    if (bg) (D.bgFeatures[String(bg.feature || '').toLowerCase()]?.featsAdd || []).forEach((f, i) => {
      const key = typeof f === 'string' ? f.toLowerCase() : f.key;
      if (D.feats[key]) slots.push({ id: 'bg' + i, kind: 'background', label: 'Talento del background', feat: key, choice: typeof f === 'object' ? f.choice : undefined, fixed: true });
    });
    if (race?.featsAdd || sub?.featsAdd) slots.push({ id: 'origin', kind: 'origin', label: "Talento d'origine", feat: c.originFeat || '', choice: c.originFeatChoice || '' });
    let i = 0;
    for (const e of entries) {
      const levels = (e.cls.improvements || []).slice(0, e.level);
      levels.forEach((n, li) => { for (let j = n - (levels[li - 1] || 0); j > 0; j--) {
        const a = (c.asi || [])[i] || {};
        slots.push({ id: 'asi' + i, kind: 'asi', label: `Aumento caratteristiche · ${e.cls.name} ${li + 1}`, feat: a.feat || '', choice: a.choice || '', a: a.a, b: a.b, index: i });
        i++;
      } });
    }
    (c.extraFeats || []).forEach((x, k) => slots.push({ id: 'extra' + k, kind: 'extra', label: `Talento extra ${k + 1}`, feat: x.feat || '', choice: x.choice || '', index: k }));
    return slots;
  }

  // ---- Every object that is active for this character, in sheet order ----
  function activeObjects(c, D, lvl, entries) {
    const { race, sub } = raceOf(c, D);
    const bg = D.backgrounds[c.background];
    const out = [];
    const push = (id, kind, label, obj, extra) => obj && out.push({ id, kind, label, obj, ...extra });
    const features = (owner, ownerName, list, olvl, legacy) => (list || []).filter(f => (f.minlevel || 1) <= olvl).forEach(f => {
      const base = { owner, lvl: olvl };
      push(owner + '>' + f.key, 'feature', ownerName, f, { ...base, feature: f });
      const val = choiceOf(c, owner, f.key, legacy);
      const ch = findOpt(f.choices, val);
      if (ch && (ch.minlevel || 1) <= olvl) push(owner + '>' + f.key + '>' + ch.key, 'choice', f.name, ch, { ...base, parent: f });
      if (f.fightingStyle && D.feats[val]) push(owner + '>' + f.key + '>' + val, 'feat', f.name, D.feats[val], { ...base, featKey: val });
      const picked = new Set([...extraOf(c, owner, f.key, legacy), ...(f.autoExtra || []).filter(a => (a.minlevel || 1) <= olvl).map(a => a.key)]);
      (f.extrachoices || []).filter(x => picked.has(x.key)).forEach(x => push(owner + '>' + f.key + '>' + x.key, 'extrachoice', f.extraname || f.name, x, { ...base, parent: f }));
    });
    if (race) { push('race', 'race', race.name, race, { owner: 'race', lvl }); features('race', race.name, race.features, lvl, true); }
    if (sub) { push('subrace', 'race', sub.name, sub, { owner: 'subrace', lvl }); features('subrace', sub.name, sub.features, lvl, true); }
    if (bg) {
      push('bg', 'background', bg.name, { name: bg.name, languageProfs: bg.languages, src: bg.src, code: bg.code }, { owner: 'bg', lvl });
      const bfx = D.bgFeatures[String(bg.feature || '').toLowerCase()];
      if (bfx?.code) push('bgfeat', 'background', bg.feature, { name: bg.feature, code: bfx.code, src: bfx.src }, { owner: 'bg', lvl });
      const v = c.bgVariant && D.bgVariants?.[c.bgVariant];
      if (v) push('bgvar', 'background', v.name, { languageProfs: v.languages, skills: v.skills, skillstxt: v.skillstxt, src: v.src, name: v.name }, { owner: 'bg', lvl });
    }
    entries.forEach((e, i) => {
      features('cls:' + e.key, e.cls.name, e.cls.features, e.level, i === 0);
      if (e.subcls) features('sub:' + e.key, e.subcls.name, e.subcls.features, e.level, i === 0);
    });
    featSlots(c, D, entries).forEach(sl => {
      const f = D.feats[sl.feat];
      if (!f) return;
      push('feat:' + sl.id, 'feat', sl.label, f, { owner: 'feat', lvl, featKey: sl.feat, slot: sl });
      const ch = findOpt(f.choices, sl.choice);
      if (ch) push('feat:' + sl.id + '>' + ch.key, 'choice', f.name, ch, { owner: 'feat', lvl, parent: f });
    });
    (c.magicItems || []).forEach((it, i) => {
      const mi = D.magicItems?.[it.key];
      if (!mi || (mi.attunement && !it.attuned)) return; // attunement items only work while attuned
      push('item:' + i, 'item', mi.name, mi, { owner: 'item', lvl, itemKey: it.key });
      const ch = findOpt(mi.choices, it.choice);
      if (ch) push('item:' + i + '>' + ch.key, 'choice', mi.name, ch, { owner: 'item', lvl, parent: mi });
    });
    return out;
  }

  // ---- Collect raw effects (before ability scores are known) ----
  function collectEffects(active) {
    const fx = { skills: [], skillChoices: [], armor: [false, false, false, false], weapons: [false, false, []], tools: [], languages: [], saves: [],
      dmgres: [], adv: [], immune: [], saveNotes: [], vision: [], speed: [], addMod: [], extraAC: [], scores: [0, 0, 0, 0, 0, 0], scoresOverride: [0, 0, 0, 0, 0, 0],
      spellBonus: [], spellExtra: [], actions: [], limited: [], calcText: [], weaponOptions: [], notes: [], code: [], creatures: [], wildshape: [] };
    for (const a of active) {
      const o = a.obj, label = o.name || a.label;
      [].concat(o.skills || []).forEach(s => fx.skills.push(Array.isArray(s) ? { name: s[0], exp: /full|exp/i.test(s[1] || '') } : { name: s }));
      if (o.skillstxt && a.id !== 'bg') { const p = parseChoice(o.skillstxt); if (p.count) fx.skillChoices.push({ ...p, label, text: o.skillstxt }); }
      if (Array.isArray(o.armorProfs)) o.armorProfs.forEach((v, i) => { if (v === true && i < 4) fx.armor[i] = true; });
      if (Array.isArray(o.weaponProfs)) { if (o.weaponProfs[0] === true) fx.weapons[0] = true; if (o.weaponProfs[1] === true) fx.weapons[1] = true; if (Array.isArray(o.weaponProfs[2])) fx.weapons[2].push(...o.weaponProfs[2]); }
      [].concat(o.toolProfs || []).forEach(t => fx.tools.push(Array.isArray(t) ? (typeof t[1] === 'number' && !t[0] ? `${t[1]} a scelta` : t[0] + (typeof t[1] === 'number' && t[1] > 1 ? ` (${t[1]})` : '')) : String(t)));
      [].concat(o.languageProfs || []).forEach(l => fx.languages.push(typeof l === 'number' ? `${l} a scelta` : Array.isArray(l) ? l[0] : String(l)));
      [].concat(o.saves || []).forEach(s => { const i = abIndex(s); if (i >= 0) fx.saves.push(ABIL[i]); });
      [].concat(o.dmgres || []).forEach(r => fx.dmgres.push(Array.isArray(r) ? r[1] || r[0] : String(r)));
      if (o.savetxt) { fx.adv.push(...[].concat(o.savetxt.adv_vs || [])); fx.immune.push(...[].concat(o.savetxt.immune || [])); fx.saveNotes.push(...[].concat(o.savetxt.text || [])); }
      [].concat(o.vision || []).forEach(v => fx.vision.push(Array.isArray(v) ? { name: v[0], range: v[1] } : { name: String(v), range: 0 }));
      if (o.speed && typeof o.speed === 'object') fx.speed.push(o.speed);
      (o.addMod || []).forEach(x => fx.addMod.push({ ...x, from: label }));
      (o.extraAC || []).forEach(x => fx.extraAC.push({ ...x, from: x.name || label }));
      if (Array.isArray(o.scores) && a.kind !== 'race') o.scores.slice(0, 6).forEach((v, i) => fx.scores[i] += +v || 0);
      if (Array.isArray(o.scoresOverride)) o.scoresOverride.slice(0, 6).forEach((v, i) => { fx.scoresOverride[i] = Math.max(fx.scoresOverride[i], +v || 0); });
      (o.spellcastingBonus || []).forEach((sb, i) => fx.spellBonus.push({ ...sb, id: a.id + '#' + i, from: label, ability: sb.spellcastingAbility ?? o.spellcastingAbility, lvl: a.lvl, kind: a.kind }));
      (o.creaturesAdd || []).forEach(n => fx.creatures.push({ name: n, from: label, options: o.creatureOptions || [], lvl: a.lvl, owner: a.owner }));
      if (o.wildshape) fx.wildshape.push(o.wildshape);
      if (Array.isArray(o.spellcastingExtra)) o.spellcastingExtra.filter(x => typeof x === 'string').forEach(k => fx.spellExtra.push({ key: k, owner: a.owner }));
      [].concat(o.action || []).forEach(x => Array.isArray(x) && fx.actions.push({ type: x[0], name: (x[1] && !/^\s*\(/.test(x[1]) ? x[1] : (o.limfeaname || label) + (x[1] || '')), from: label }));
      if (o.usages !== undefined || o.usagescalc) fx.limited.push({ name: o.limfeaname || label, usages: o.usages, usagescalc: o.usagescalc, recovery: o.recovery, additional: o.additional, from: label, lvl: a.lvl });
      (o.extraLimitedFeatures || []).forEach(x => x && x.name && fx.limited.push({ name: x.name, usages: x.usages, usagescalc: x.usagescalc, recovery: x.recovery, additional: x.additional, from: label, lvl: a.lvl }));
      (o.calcText || []).forEach(t => fx.calcText.push({ text: t, from: label }));
      (o.weaponOptions || []).forEach(w => fx.weaponOptions.push({ ...w, from: label }));
      if (o.code) fx.code.push({ code: o.code, from: label, obj: o, active: a });
      if (+o.carryingCapacity > 0) fx.carry = (fx.carry || 1) * +o.carryingCapacity;
    }
    return fx;
  }

  // ---- Ability scores: only the base edition's rule for origin bonuses (no double dipping in mixed campaigns) ----
  // 2014 rules: racial bonuses; a species without them (e.g. a 2024 species) uses Tasha's "Customizing Your Origin" (+2/+1 or +1/+1/+1).
  // 2024 rules: the background's +2/+1 or +1/+1/+1 among its three abilities (a background without that list: any abilities).
  function originRule(c, D) {
    const { race, sub } = raceOf(c, D);
    if (c.edition !== '2024') {
      const fixed = [race?.scores, sub?.scores].some(x => (x || []).some(Number));
      if (fixed || !race || race.scorestxt) return { kind: 'race', allowed: [] };
      return { kind: 'tasha', allowed: [0, 1, 2, 3, 4, 5], key: 'raceBonus' };
    }
    const allowed = backgroundAbilities(D.backgrounds[c.background]?.scorestxt);
    return { kind: 'background', allowed: allowed.length ? allowed : [0, 1, 2, 3, 4, 5], key: 'bgBonus', free: !allowed.length };
  }
  function abilityScores(c, D, fx, slots) {
    const { race, sub } = raceOf(c, D);
    const base = (c.base || STANDARD_ARRAY).map(Number);
    const bonus = [0, 0, 0, 0, 0, 0];
    const add = (arr) => arr && arr.slice(0, 6).forEach((v, i) => bonus[i] += +v || 0);
    const rule = originRule(c, D);
    if (rule.kind === 'race') { add(race?.scores); add(sub?.scores); }
    else {
      const b = c[rule.key] || {}, ok = i => i !== '' && i != null && rule.allowed.includes(+i);
      if (b.mode === '111') {
        if (rule.allowed.length === 3) rule.allowed.forEach(i => bonus[i] += 1);
        else [...new Set([b.plus2, b.plus1, b.plus3].filter(ok).map(Number))].forEach(i => bonus[i] += 1);
      } else {
        if (ok(b.plus2)) bonus[+b.plus2] += 2;
        if (ok(b.plus1) && +b.plus1 !== +b.plus2) bonus[+b.plus1] += 1;
      }
    }
    add(fx?.scores);
    // ASI slots not taken as a feat: +1/+1 (same ability twice = +2)
    (slots || []).filter(s => s.kind === 'asi' && !s.feat).forEach(s => { [s.a, s.b].forEach(x => { if (x !== '' && x != null && ABIL[+x]) bonus[+x] += 1; }); });
    add((c.adjust || []).map(Number));
    // ponytail: 20 cap ignores capstones (Barbarian Primal Champion etc.), raise when those matter
    const total = base.map((s, i) => Math.max(Math.min(20, s + bonus[i]), fx?.scoresOverride?.[i] || 0));
    return { base, bonus, total, mods: total.map(mod), rule };
  }

  // Who casts: the class, or a subclass that adds spellcasting (Eldritch Knight, Arcane Trickster…)
  function casterOf(cls, subcls) {
    if (cls?.casterFactor && cls.casting) return { factor: cls.casterFactor, casting: cls.casting, abilitySave: cls.abilitySave, list: cls.spellList, roundUp: cls.roundUp, ed: cls.ed };
    if (subcls?.casterFactor && subcls.casting) return { factor: subcls.casterFactor, casting: subcls.casting, abilitySave: subcls.abilitySave || cls?.abilitySave, list: subcls.spellList, ed: subcls.ed || cls?.ed };
    return null;
  }
  const isPact = caster => String(caster?.factor).startsWith('warlock');
  // contribution to the multiclass caster level (PHB 2014 p.164; 2024 rounds half casters up)
  function multiCasterLevel(c, caster, n) {
    const f = +caster.factor;
    if (!f) return 0;
    if (f === 1) return n;
    return (f === 2 && ((caster.ed || c.edition) === '2024' || caster.roundUp)) ? Math.ceil(n / f) : Math.floor(n / f);
  }
  function spellcasting(c, caster, mods, pb, lvl) {
    if (!caster) return null;
    const k = caster.casting, ab = (caster.abilitySave || 1) - 1;
    let slots = [], pact = null;
    if (isPact(caster)) {
      pact = { count: PACT_SLOTS[lvl - 1], level: Math.min(5, Math.ceil(lvl / 2)) };
    } else {
      const f = +caster.factor;
      // single-class tables: half/third casters round up once they have slots (2014: from level f; 2024 and round-up casters: from level 1)
      const casterLvl = !f ? 0 : f === 1 ? lvl : ((caster.ed || c.edition) === '2024' || caster.roundUp || lvl >= f) ? Math.ceil(lvl / f) : 0;
      slots = SLOTS[casterLvl] || [];
    }
    const maxLevel = Math.min(pact ? pact.level : slots.length, caster.list?.level?.[1] ?? 9);
    const cantrips = k.cantrips ? atLevel(k.cantrips, lvl) || 0 : 0;
    let prepared = null, known = null;
    if (Array.isArray(k.prepared)) prepared = k.prepared[lvl - 1];
    else if (Array.isArray(k.spells)) known = k.spells[lvl - 1];
    else if (k.prepared || k.spells === 'book') prepared = Math.max(1, mods[ab] + (+caster.factor === 2 ? Math.floor(lvl / 2) : lvl));
    const preparedCaster = prepared != null && k.spells !== 'book' || k.spells === 'list';
    return { ability: ABIL[ab], dc: 8 + pb + mods[ab], attack: pb + mods[ab], slots, pact, maxLevel, cantrips, prepared, known,
      spellbook: k.spells === 'book', preparedCaster, schools: caster.list?.school };
  }
  // the spells chosen for one casting class (older characters kept the first class's spells in c.spells)
  const spellsOf = (c, key) => (c.classSpells || {})[key] ?? (key === c.cls ? c.spells || [] : []);

  // Spell access for one casting class: its list (or its subclass's list), dunamancy, expanded lists (spellcastingExtra)
  function spellAccess(c, D, key) {
    const lvl = Math.max(1, Math.min(20, +c.level || 1));
    const { entries } = classLevels(c, D);
    const e = entries.find(x => x.key === (key || c.cls)) || entries[0];
    if (!e) return { extra: [], listClass: key };
    const caster = casterOf(e.cls, e.subcls);
    const fx = collectEffects(activeObjects(c, D, lvl, entries));
    const first = entries.find(x => casterOf(x.cls, x.subcls))?.key;
    const extra = [...(e.subcls?.spellExtra || []), ...fx.spellExtra.filter(x => x.owner === 'cls:' + e.key || x.owner === 'sub:' + e.key || (!/^(cls|sub):/.test(x.owner) && e.key === first)).map(x => x.key)];
    const listClass = caster?.list?.class || e.key;
    const mods = caster ? runSpellList(c, D, fx, { class: [listClass], level: [0, 9], school: caster.list?.school }, baseKey(e.key), caster.casting?.spells === 'book' ? 'book' : caster.casting?.prepared || caster.casting?.spells === 'list' ? 'list' : 'known') : {};
    return { entry: e, caster, extra, listClass, listExtra: mods.extra || [], not: mods.not || [], dunamancy: baseKey(e.key) === 'wizard' && /chronurgy|graviturgy/.test(e.subKey || '') };
  }
  // native stand-ins for MPMB's spell list helpers used by spellList code
  function createSpellList(D, o) {
    const classes = o.class && o.class !== 'any' ? [].concat(o.class) : null, sch = o.school ? [].concat(o.school) : null;
    return Object.entries(D.spells).filter(([k, sp]) => (!o.spells || o.spells.includes(k)) && (!classes || classes.some(cl => sp.classes.includes(cl)))
      && (!o.level || (sp.level >= o.level[0] && sp.level <= o.level[1])) && (!sch || sch.includes(sp.school)) && (!o.ritual || sp.ritual)).map(([k]) => k);
  }
  function runSpellList(c, D, fx, list, spName, spType) {
    const fns = fx.code.filter(x => x.code.spellList);
    if (!fns.length) return {};
    const spList = { ...list, extraspells: [], notspells: [] };
    const classList = {};
    Object.keys(D.classes).forEach(k => { classList[baseKey(k)] = D.classes[k]; });
    const cur = {};
    Object.keys(c.classSpells || {}).forEach(k => { cur[baseKey(k)] = { name: D.classes[k]?.name || k, selectCa: [], selectSp: (c.classSpells[k] || []).map(baseKey), selectBo: [], bonus: {} }; });
    cur[spName] = cur[spName] || { name: spName, selectCa: [], selectSp: [], selectBo: [], bonus: {} };
    SHIM = { ...SHIM, ClassList: classList, SpellsList: D.spells, CurrentSpells: cur, isArray: Array.isArray,
      How: f => f === 'Proficiency Bonus' ? profBonus(+c.level || 1) : '', What: f => f === 'Proficiency Bonus' ? profBonus(+c.level || 1) : '',
      CreateSpellList: o => createSpellList(D, o || {}), OrderSpells: l => [].concat(l || []) };
    for (const x of fns) call(x.code.spellList, spList, spName, spType);
    const ok = k => !!D.spells[k];
    return { extra: (spList.extraspells || []).filter(ok), not: (spList.notspells || []).filter(ok), only: Array.isArray(spList.spells) ? spList.spells.filter(ok) : null };
  }
  const inList = (s, key, acc, casting) => !!s && !(acc.not || []).includes(key) && (s.classes.includes(acc.listClass) || (!!s.dunamancy && acc.dunamancy)
    || (acc.listExtra || []).includes(key) || (!casting?.preparedCaster && acc.extra.includes(key)));
  // Can this character learn the spell from one of its casting classes?
  function canLearn(key, c, D) {
    const s = D.spells[key];
    if (!s) return false;
    return compute(c, D).castings.some(cs => inList(s, key, spellAccess(c, D, cs.cls), cs));
  }
  // Spells a casting class (or casting subclass) can pick at its level (cantrips + levels it has slots for)
  function spellOptions(c, D, casting) {
    if (!casting) return [];
    const acc = spellAccess(c, D, casting.cls);
    return Object.entries(D.spells)
      .filter(([key, s]) => inList(s, key, acc, casting) && (s.level === 0 ? casting.cantrips > 0 : s.level <= casting.maxLevel))
      .map(([key, s]) => ({ key, ...s, offList: !!casting.schools && s.level > 0 && !casting.schools.includes(s.school) }))
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  }

  // Bonus spell grants (spellcastingBonus): fixed spells, or picks from a filtered list
  function grantOptions(g, D) {
    if (g.only) return g.only.filter(k => D.spells[k]).map(k => ({ key: k, ...D.spells[k] }));
    if (g.spells && !g.fixed) return g.spells.filter(k => D.spells[k]).map(k => ({ key: k, ...D.spells[k] }));
    const classes = g.class && g.class !== 'any' ? [].concat(g.class) : null;
    return Object.entries(D.spells).filter(([, s]) =>
      (!classes || classes.some(cl => s.classes.includes(cl))) && (!g.level || (s.level >= g.level[0] && s.level <= g.level[1]))
      && (!g.school || [].concat(g.school).includes(s.school)) && (!g.ritual || s.ritual))
      .concat((g.extra || []).filter(k => D.spells[k]).map(k => [k, D.spells[k]])).filter(([k], i, arr) => !(g.not || []).includes(k) && arr.findIndex(x => x[0] === k) === i)
      .map(([key, s]) => ({ key, ...s })).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  }
  function bonusGrants(c, D, fx, lvl, mods, pb) {
    return fx.spellBonus.map(sb => {
      const count = Math.max(1, +atLevel(sb.times, sb.lvl || lvl) || 1);
      const fixed = Array.isArray(sb.spells) && Array.isArray(sb.selection) && sb.spells.length <= Math.max(count, sb.selection.length) && sb.selection.length >= sb.spells.length;
      const g = { id: sb.id, label: sb.name || sb.from, from: sb.from, count, fixed, spells: sb.spells, class: sb.class, level: sb.level, school: sb.school, ritual: sb.ritual,
        note: FIRSTCOL[sb.firstCol] || (typeof sb.firstCol === 'number' ? `${sb.firstCol} cariche` : ''), prepared: !!sb.prepared, atwill: !!sb.atwill };
      const ai = typeof sb.ability === 'number' ? sb.ability - 1 : -1;
      if (ai >= 0 && ai < 6) { g.ability = ABIL[ai]; g.dc = 8 + pb + mods[ai]; g.attack = pb + mods[ai]; }
      if (!fixed) {
        const mod = runSpellList(c, D, fx, { name: sb.name, class: sb.class, level: sb.level, school: sb.school, ritual: sb.ritual, spells: sb.spells }, String(sb.from || '').toLowerCase(), (sb.kind === 'item' ? 'item' : sb.kind === 'race' ? 'race' : 'feat') + '-bonus');
        g.extra = mod.extra; g.not = mod.not; g.only = mod.only;
      }
      g.chosen = fixed ? sb.spells.filter(k => D.spells[k]) : ((c.bonusSpells || {})[sb.id] || []).filter(k => D.spells[k]).slice(0, count);
      return g;
    });
  }

  // ---- Equipment: carried weight (armour, weapons, magic items, gear, coins) vs carrying capacity (PHB p.176, variant encumbrance) ----
  function inventory(c, D, scores, race, fx) {
    const rows = [];
    const armour = D.armour[c.armour];
    if (armour) rows.push({ name: armour.name, qty: 1, weight: +armour.weight || 0, kind: 'armour' });
    if (c.shield) rows.push({ name: 'Shield', qty: 1, weight: 6, kind: 'armour' });
    (c.weapons || []).forEach(k => { const w = D.weapons[k]; if (w && w.list !== 'spell') rows.push({ name: w.name, qty: 1, weight: +w.weight || 0, kind: 'weapon' }); });
    (c.magicItems || []).forEach(it => { const mi = D.magicItems?.[it.key]; if (mi) rows.push({ name: mi.name, qty: 1, weight: +mi.weight || 0, kind: 'magic', attuned: !!it.attuned }); });
    (c.inventory || []).forEach(it => it && it.name && rows.push({ name: it.name, qty: +it.qty || 1, weight: +it.weight || 0, kind: 'gear' }));
    const coins = c.coins || {};
    const nCoins = ['cp', 'sp', 'ep', 'gp', 'pp'].reduce((t, k) => t + (+coins[k] || 0), 0);
    const total = Math.round((rows.reduce((t, r) => t + r.qty * r.weight, 0) + nCoins / 50) * 100) / 100;
    // capacity: Str × 15, doubled per size above Medium / per MPMB carryingCapacity multipliers (Powerful Build…)
    const size = Array.isArray(race?.size) ? Math.min(...race.size) : race?.size;
    const mult = (fx.carry || 1) * (size === 2 ? 2 : size === 1 ? 4 : 1);
    const str = scores[0], cap = str * 15 * mult;
    const attuned = (c.magicItems || []).filter(it => it.attuned && D.magicItems?.[it.key]?.attunement).length;
    return { rows, total, capacity: cap, push: cap * 2, encumbered: str * 5 * mult, heavy: str * 10 * mult,
      status: total > cap ? 'oltre la capacità' : total > str * 10 * mult ? 'pesantemente ingombrato (variante)' : total > str * 5 * mult ? 'ingombrato (variante)' : 'normale',
      coins: { cp: +coins.cp || 0, sp: +coins.sp || 0, ep: +coins.ep || 0, gp: +coins.gp || 0, pp: +coins.pp || 0 },
      gpValue: Math.round(((+coins.cp || 0) / 100 + (+coins.sp || 0) / 10 + (+coins.ep || 0) / 2 + (+coins.gp || 0) + (+coins.pp || 0) * 10) * 100) / 100, attuned, attuneMax: 3 };
  }
  // ---- Wild Shape (druid) and companions: beast forms allowed at the druid's level (PHB 2014 p.66; Circle of the Moon p.69; 2024 PHB p.80) ----
  const crNum = cr => typeof cr === 'number' ? cr : /\//.test(String(cr)) ? (([a, b]) => a / b)(String(cr).split('/').map(Number)) : +cr || 0;
  function wildShape(c, D, entries) {
    const dr = entries.find(e => baseKey(e.key) === 'druid');
    if (!dr || dr.level < 2) return null;
    const n = dr.level, moon = /moon/.test(dr.subKey || ''), ed24 = (dr.cls.ed || c.edition) === '2024';
    let maxCR = n >= 8 ? 1 : n >= 4 ? 0.5 : 0.25, noFly = n < 8, noSwim = n < 4;
    if (moon) maxCR = n >= 6 ? Math.floor(n / 3) : 1;
    if (ed24) { maxCR = moon ? Math.max(1, Math.floor(n / 3)) : n >= 8 ? 1 : n >= 4 ? 0.5 : 0.25; noFly = n < 8; noSwim = false; }
    const forms = Object.entries(D.creatures || {}).filter(([, m]) => /beast/i.test(m.type || '') && crNum(m.cr) <= maxCR
      && !(noFly && /fly/i.test(m.speed || '')) && !(noSwim && /swim/i.test(m.speed || ''))).map(([key, m]) => ({ key, ...m, crNum: crNum(m.cr) }))
      .sort((a, b) => b.crNum - a.crNum || a.name.localeCompare(b.name));
    return { level: n, moon, maxCR, noFly, noSwim, forms };
  }

  // Companion sources: features' creaturesAdd (a companion type by name, or a specific creature: feature's creatureOptions or the
  // creature list), spells known (Find Familiar / Find Steed / Find Greater Steed). Forms of a type: MPMB includeCheck code, or the
  // creatures tagged with that companion type. c.companions = {slotId: creatureKey}; c.companion = free pick (with the DM).
  const SPELL_COMPANION = { 'find familiar': 'familiar', 'find steed': 'mount', 'find greater steed': 'steed' };
  function companionSlots(c, D, s, fx) {
    const types = D.companions || {}, slots = [], seen = new Set();
    const typeByName = n => Object.keys(types).find(k => types[k].name.toLowerCase() === String(n).toLowerCase());
    const addType = (k, from) => { if (k && types[k] && !seen.has('type:' + k)) { seen.add('type:' + k); slots.push({ id: 'type:' + k, kind: 'type', type: k, name: types[k].name, from }); } };
    fx.creatures.forEach(x => {
      const t = typeByName(x.name);
      if (t) return addType(t, x.from);
      const own = x.options.find(o => o.name.toLowerCase() === x.name.toLowerCase());
      const key = Object.keys(D.creatures || {}).find(k => D.creatures[k].name.toLowerCase() === x.name.toLowerCase());
      if ((own || key) && !seen.has('fixed:' + x.name)) { seen.add('fixed:' + x.name); slots.push({ id: 'fixed:' + x.name, kind: 'fixed', name: x.name, from: x.from, creature: own || null, key, owner: x.owner }); }
    });
    const known = new Set([...(s.castings || []).flatMap(cs => spellsOf(c, cs.cls).concat(cs.alwaysPrepared)), ...(s.grants || []).flatMap(g => g.chosen)].map(baseKey));
    Object.entries(SPELL_COMPANION).forEach(([sp, t]) => { if (known.has(sp)) addType(t, D.spells[sp]?.name || sp); });
    if (s.active.some(a => /pact of the chain/i.test(a.name))) addType('pact_of_the_chain', 'Pact of the Chain');
    if (s.active.some(a => /^undead thralls$/i.test(a.name))) addType('undead_thrall', 'Undead Thralls');
    if (s.active.some(a => /strixhaven mascot/i.test(a.name))) addType('strixhaven_mascot', 'Strixhaven Mascot');
    setShim(s, c, D);
    slots.forEach(sl => {
      if (sl.kind !== 'type') return;
      const t = types[sl.type];
      // MPMB: creatures tagged with the companion type, plus those its includeCheck code accepts
      sl.forms = Object.entries(D.creatures || {}).filter(([k, m]) => {
        if ([].concat(m.companion || []).some(x => x === sl.type || x === sl.type + '_not_al')) return true;
        if (!t.include) return false;
        const r = call(t.include, baseKey(k), { ...m, type: m.type || '', companion: m.companion || [] }, crNum(m.cr), false);
        return r === true || typeof r === 'string';
      }).map(([k, m]) => ({ key: k, name: m.name, cr: m.cr, type: m.type })).sort((a, b) => a.name.localeCompare(b.name));
      sl.chosen = (c.companions || {})[sl.id] || '';
      if (sl.chosen && !sl.forms.some(f => f.key === sl.chosen)) sl.chosen = '';
    });
    return slots;
  }
  // the companion's stat block: creature + MPMB attributesChange/attributesAdd; AC formulas ("13+oWis", "11+Dex+Prof") resolved
  function companionBlock(sl, c, D, s) {
    const base = sl.kind === 'fixed' ? (sl.creature || D.creatures[sl.key]) : D.creatures[sl.chosen];
    if (!base) return null;
    const m = JSON.parse(JSON.stringify(base)), t = sl.kind === 'type' ? D.companions[sl.type] : null;
    if (t?.change) { setShim(s, c, D); call(t.change, baseKey(sl.chosen || ''), m); }
    if (t?.type) m.type = [].concat(t.type).join(' / ');
    const owner = s.abilities.mods, opb = s.pb, cm = i => Math.floor(((m.scores?.[i] ?? 10) - 10) / 2);
    const pb = m.pbLinked ? opb : m.pb || 2;
    if (typeof m.ac === 'string') {
      let expr = m.ac.replace(/\bo(Str|Dex|Con|Int|Wis|Cha)\b/g, (_, a) => `(${owner[abIndex(a)]})`).replace(/\boProf\b/g, `(${opb})`).replace(/\bProf\b/g, `(${pb})`)
        .replace(/\b(Str|Dex|Con|Int|Wis|Cha)\b/g, (_, a) => `(${cm(abIndex(a))})`);
      const v = evalMod(expr, owner, opb); m.acText = m.ac; m.ac = /^[\d\s+\-()]+$/.test(expr) ? Function('return ' + expr)() : v || m.ac;
    }
    if (m.hdLinked) { const lv = [].concat(m.hdLinked).map(k => s.classes.find(e => baseKey(e.key) === k)?.level || 0).reduce((a, b) => Math.max(a, b), 0); if (lv && m.hd) m.hd = [lv, m.hd[1]]; }
    m.traits = (m.traits || []).filter(x => !x.minlevel || x.minlevel <= s.level).concat(t?.traits || []);
    m.notes = t?.notes || [];
    m.header = t?.header || sl.name;
    m.pb = pb;
    return m;
  }
  // Wild Shape: the sheets' own table when present (2024: known forms, max CR, Fly), else the PHB 2014 rules
  function wildShapeFrom(c, D, entries, fx) {
    const dr = entries.find(e => baseKey(e.key) === 'druid');
    if (!dr || dr.level < 2) return null;
    const n = dr.level, moon = /moon/.test(dr.subKey || '');
    const t = fx.wildshape[fx.wildshape.length - 1];
    let maxCR, noFly, noSwim = false, known = null, tempHP = null, duration = null;
    if (t?.limits) {
      const lim = String(atLevel(t.limits, n) || '');
      maxCR = crNum((lim.match(/CR\s*(\d+\/\d+|\d+)/i) || [])[1] || 0);
      noFly = /no fly/i.test(lim);
      known = +(String(atLevel(t.known, n) || '').match(/\d+/) || [0])[0] || null;
      tempHP = atLevel(t.tempHP, n) ?? null; duration = atLevel(t.duration, n) || null;
    } else {
      maxCR = moon ? (n >= 6 ? Math.floor(n / 3) : 1) : n >= 8 ? 1 : n >= 4 ? 0.5 : 0.25;
      noFly = n < 8; noSwim = n < 4;
      duration = `${Math.floor(n / 2)} ore`;
    }
    const forms = Object.entries(D.creatures || {}).filter(([, m]) => /beast/i.test(m.type || '') && crNum(m.cr) <= maxCR
      && !(noFly && /fly/i.test(m.speed || '')) && !(noSwim && /swim/i.test(m.speed || ''))).map(([key, m]) => ({ key, ...m, crNum: crNum(m.cr) }))
      .sort((a, b) => b.crNum - a.crNum || a.name.localeCompare(b.name));
    const chosen = (c.wildForms || []).filter(k => forms.some(f => f.key === k));
    return { level: n, moon, maxCR, noFly, noSwim, forms, known, chosen, tempHP, duration };
  }

  // "Strength 13 or Dexterity 13" / "Wisdom 13 and Dexterity 13" -> met?
  function meetsPrereq(txt, scores) {
    if (!txt) return true;
    const parts = String(txt).split(/\bor\b/i).map(p => [...p.matchAll(/(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*(\d+)/gi)].map(m => scores[ABIL_FULL.findIndex(n => n.toLowerCase() === m[1].toLowerCase())] >= +m[2]));
    const relevant = parts.filter(p => p.length);
    return !relevant.length || relevant.some(p => p.every(Boolean));
  }

  function compute(c, D) {
    const lvl = Math.max(1, Math.min(20, +c.level || 1));
    c = { ...c, level: lvl };
    const { race, sub } = raceOf(c, D);
    const { seq, entries } = classLevels(c, D);
    const primary = entries[0];
    const cls = primary?.cls, subcls = primary?.subcls || null;
    const bg = D.backgrounds[c.background];
    const warnings = [];
    const slots = featSlots(c, D, entries);
    const active = activeObjects(c, D, lvl, entries);
    const fx = collectEffects(active);
    const ab = abilityScores(c, D, fx, slots);
    const m = ab.mods, pb = profBonus(lvl);
    const ev = x => evalMod(x, m, pb);
    const has = re => active.some(a => re.test(a.obj.name || ''));
    const levelOf = k => entries.find(e => baseKey(e.key) === k)?.level || 0;
    const edOf = o => o?.ed || c.edition;

    // Multiclass prerequisites (PHB p.163: the new class and every class you already have)
    if (entries.length > 1) entries.forEach(e => { if (!meetsPrereq(e.cls.prereqs, ab.total)) warnings.push(`Multiclasse ${e.cls.name}: requisito non soddisfatto (${e.cls.prereqs}).`); });

    // Proficiencies: first class in full, later classes only their multiclass proficiencies (+ everything active)
    const later = entries.slice(1);
    const armorProf = [0, 1, 2, 3].map(i => !!cls?.armor?.[i] || later.some(e => !!e.cls.armor2?.[i]) || fx.armor[i]);
    const wlist = [cls?.weapons?.[2], ...later.map(e => e.cls.weapons2?.[2])].filter(Array.isArray).flat();
    const weaponProf = { simple: !!cls?.weapons?.[0] || later.some(e => !!e.cls.weapons2?.[0]) || fx.weapons[0], martial: !!cls?.weapons?.[1] || later.some(e => !!e.cls.weapons2?.[1]) || fx.weapons[1],
      list: [...wlist, ...fx.weapons[2]].map(w => String(w).toLowerCase()) };
    const toolName = t => Array.isArray(t) ? t[0] : t;
    const tools = [...new Set([...(cls?.tools || []), ...later.flatMap(e => e.cls.tools2 || [])].map(toolName).filter(t => typeof t === 'string' && t)
      .concat(bg?.tools || [], fx.tools))];
    const languages = [...new Set(fx.languages)];

    // addMod targets
    const modsFor = (type, field) => fx.addMod.filter(x => x.type === type && (x.field === field || x.field === 'all')).reduce((t, x) => t + ev(x.mod), 0);

    // Saves (first class only) & skills
    const saveProf = new Set([...(cls?.saves || []), ...fx.saves]);
    const saves = ABIL.map((a, i) => ({ ab: a, prof: saveProf.has(a), total: m[i] + (saveProf.has(a) ? pb : 0) + modsFor('save', a) }));
    const fixedSkills = new Set([...fx.skills.map(s => s.name), ...(bg?.skills || [])]);
    const autoExp = new Set(fx.skills.filter(s => s.exp).map(s => s.name));
    const chosen = new Set(c.skills || []);
    const expertise = new Set([...(c.expertise || []), ...autoExp]);
    const jack = levelOf('bard') >= 2 || has(/^Jack of All Trades/);
    const skills = SKILLS.map(s => {
      const prof = fixedSkills.has(s.name) || chosen.has(s.name), exp = prof && expertise.has(s.name);
      const bonus = m[s.ab] + (exp ? 2 * pb : prof ? pb : jack ? Math.floor(pb / 2) : 0) + fx.addMod.filter(x => x.type === 'skill' && x.field === s.abbr).reduce((t, x) => t + ev(x.mod), 0);
      return { ...s, abName: ABIL[s.ab], prof, exp, fixed: fixedSkills.has(s.name), total: bonus };
    });
    const classChoice = parseChoice(cls?.skillstxt);
    const multiChoices = later.map(e => ({ ...parseChoice(e.cls.skillstxt2), label: e.cls.name, text: e.cls.skillstxt2 })).filter(x => x.count);
    const extraChoices = fx.skillChoices.filter(x => !/expertise/i.test(x.text)).concat(multiChoices);
    const skillPicks = { allowed: classChoice.count + extraChoices.reduce((t, x) => t + x.count, 0), used: [...chosen].filter(s => !fixedSkills.has(s)).length,
      classOptions: classChoice.options, raceOptions: extraChoices.flatMap(x => x.options || []), sources: extraChoices.map(x => `${x.label}: ${x.text}`) };
    if (skillPicks.used > skillPicks.allowed) warnings.push(`Troppe abilità scelte (${skillPicks.used}/${skillPicks.allowed}).`);

    // Hit points: first level max die, then fixed average of each level's class die (as MPMB does by default)
    let hp = 0;
    seq.forEach((k, i) => { const d = D.classes[k]?.die || 8; hp += (i === 0 ? d : Math.floor(d / 2) + 1) + m[2]; });
    if (baseKey(c.race) === 'hill dwarf' || (baseKey(c.race) === 'dwarf' && edOf(race) === '2024')) hp += lvl; // Dwarven Toughness
    const sorc = entries.find(e => baseKey(e.key) === 'sorcerer');
    if (sorc?.subcls && /draconic/.test(sorc.subKey || '')) hp += sorc.level; // Draconic Resilience (sorcerer levels)
    if (active.some(a => baseKey(a.featKey) === 'tough')) hp += 2 * lvl; // Tough
    hp = Math.max(lvl, hp + (+c.hpBonus || 0));
    const dice = {};
    seq.forEach(k => { const d = D.classes[k]?.die || 8; dice[d] = (dice[d] || 0) + 1; });
    const hitDice = Object.entries(dice).sort((a, b) => b[0] - a[0]).map(([d, n]) => `${n}d${d}`).join(' + ');

    // Armour class: armour/unarmoured base + extraAC (stopeval code runs in the MPMB layer; common wordings interpreted otherwise)
    const armour = D.armour[c.armour];
    const shield = !!c.shield;
    let ac, acNote;
    const acParts = [];
    if (armour) {
      const dexPart = armour.type === 'light' ? m[1] : armour.type === 'medium' ? Math.min(2, m[1]) : 0;
      ac = armour.ac + dexPart; acNote = armour.name;
      const idx = { light: 0, medium: 1, heavy: 2 }[armour.type];
      if (cls && !armorProf[idx]) warnings.push(`Nessuna competenza in armature ${armour.type}.`);
    } else if (levelOf('barbarian')) { ac = 10 + m[1] + m[2]; acNote = 'Difesa senza armatura (Des+Cos)'; }
    else if (levelOf('monk') && !shield) { ac = 10 + m[1] + m[4]; acNote = 'Difesa senza armatura (Des+Sag)'; }
    else if (sorc?.subcls && /draconic/.test(sorc.subKey || '')) { ac = edOf(sorc.subcls) === '2024' ? 10 + m[1] + m[5] : 13 + m[1]; acNote = 'Resilienza draconica'; }
    else { ac = 10 + m[1]; acNote = 'Senza armatura'; }
    if (shield) { ac += 2; if (cls && !armorProf[3]) warnings.push('Nessuna competenza negli scudi.'); }
    const acConditional = [];
    const acCtx = { armour, shield, m, pb };
    for (const x of fx.extraAC) {
      const t = String(x.text || ''), v = ev(x.mod);
      let ok = !x.conditional ? true : runStopeval(x.stopeval, acCtx, c, D);
      // ponytail: when MPMB's stopeval can't run, interpret the usual wordings; unknown conditions are listed, not applied
      if (ok === undefined) ok = /(not wearing|without|no) (any )?(body )?armor|unarmored/i.test(t) ? !armour
        : /medium,? or heavy armor/i.test(t) && !/light/i.test(t) ? !!armour && /medium|heavy/.test(armour.type)
          : /(wearing|in) [^.]*armor/i.test(t) ? !!armour
            : /shield/i.test(t) ? shield : null;
      if (ok === true && v) { ac += v; acParts.push(`${sign(v)} ${x.from}`); }
      else if (ok === null) acConditional.push(`${sign(v)} ${x.from}: ${t}`);
    }

    // Speeds (MPMB: {walk:{spd:30}, fly:{spd:"walk"|60|"fixed 60"|"+10"}, allModes:{bonus:"+10", exclude:[…]}})
    // base walking speed (number); MPMB speed objects (fly/swim/climb, bonuses) come through the effects
    const speeds = { walk: +(sub?.walk || race?.walk) || 30 };
    const bonuses = [];
    fx.speed.forEach(sp => Object.entries(sp).forEach(([mode, v]) => {
      if (mode === 'allModes') { bonuses.push({ bonus: parseInt(v?.bonus) || 0, exclude: v?.exclude || [] }); return; }
      const s = v && typeof v === 'object' ? v.spd : v;
      if (typeof s === 'string' && /^\+/.test(s)) bonuses.push({ mode, bonus: parseInt(s) || 0 });
      else if (s === 'walk') speeds[mode] = Math.max(speeds[mode] || 0, -1); // resolved below
      else { const n = parseInt(String(s).replace('fixed', '')); if (n) speeds[mode] = Math.max(speeds[mode] || 0, n); }
    }));
    bonuses.filter(b => b.mode).forEach(b => { speeds[b.mode] = (speeds[b.mode] || 0) + b.bonus; });
    Object.keys(speeds).forEach(k => { if (speeds[k] === -1) speeds[k] = speeds.walk; });
    bonuses.filter(b => !b.mode).forEach(b => Object.keys(speeds).forEach(k => { if (!b.exclude.includes(k)) speeds[k] += b.bonus; }));

    // Senses
    const vision = {};
    fx.vision.forEach(v => { vision[v.name] = Math.max(vision[v.name] || 0, parseInt(v.range) || 0); });

    // Resources: usages (number | per-level array of the owning class | "Proficiency Bonus per " …) + MPMB usagescalc formulas
    const limited = fx.limited.map(x => {
      const ol = x.lvl || lvl;
      let uses = atLevel(x.usages, ol);
      const calc = String(x.usagescalc || '');
      if (/Proficiency Bonus/i.test(calc)) uses = pb;
      else { const mm = calc.match(/\b(Str|Dex|Con|Int|Wis|Cha) Mod\b/); if (mm) uses = Math.max(1, m[abIndex(mm[1])]); }
      if (typeof uses === 'string' && /proficiency bonus/i.test(uses)) uses = pb;
      return { name: x.name, uses: typeof uses === 'number' ? uses : (parseInt(uses) || uses || '—'), recovery: x.recovery || '', additional: atLevel(x.additional, ol) || '', from: x.from };
    }).filter(x => x.uses !== 0);

    // Features list for the sheet (+ chosen options, feats, attuned/used magic items)
    const features = active.filter(a => ['feature', 'choice', 'extrachoice', 'feat'].includes(a.kind)).map(a => {
      const o = a.obj;
      const source = a.kind === 'feature' ? a.label : a.kind === 'feat' ? 'Talento' : a.label;
      return { name: a.kind === 'choice' || a.kind === 'extrachoice' ? `${a.label}: ${o.name}` : o.name, level: o.minlevel || 1, source, src: o.src || a.parent?.src, desc: descAt(o.desc, a.lvl || lvl), kind: a.kind };
    });
    {
      const v = c.bgVariant && D.bgVariants?.[c.bgVariant];
      const fname = v?.feature || bg?.feature;
      const bf = bg && D.bgFeatures[String(fname || '').toLowerCase()];
      if (bf && !bf.featsAdd) features.push({ name: fname, level: 1, source: bg.name, src: bf.src, desc: descAt(bf.desc, lvl), kind: 'background' });
    }
    features.sort((a, b) => a.level - b.level);

    // Choices offered (for the GUI): feature options, invocations/maneuvers…, fighting style feats, weapon masteries — per owner
    const choiceFeatures = active.filter(a => a.kind === 'feature').filter(a => { const f = a.obj; return f.choices?.length || f.extrachoices?.length || f.fightingStyle || f.masteries; }).map(a => {
      const f = a.obj, legacy = a.owner === 'race' || a.owner === 'subrace' || (primary && (a.owner === 'cls:' + primary.key || a.owner === 'sub:' + primary.key));
      const extraCount = f.optional ? (f.extrachoices || []).filter(o => (o.minlevel || 1) <= a.lvl).length : f.extrachoices?.length ? (+atLevel(f.extraTimes, a.lvl) || (f.extraTimes ? 0 : 1)) : 0;
      const picked = extraOf(c, a.owner, f.key, legacy).filter(k => f.extrachoices?.some(x => x.key === k));
      if (extraCount && picked.length > extraCount) warnings.push(`${f.extraname || f.name}: ${picked.length} scelte su ${extraCount}.`);
      return { key: f.key, qkey: qkey(a.owner, f.key), name: f.name, owner: a.owner, ownerName: a.label, choices: (f.choices || []).filter(o => (o.minlevel || 1) <= a.lvl),
        current: choiceOf(c, a.owner, f.key, legacy) || '', extraname: f.extraname || f.name, extrachoices: (f.extrachoices || []).filter(o => (o.minlevel || 1) <= a.lvl), extraCount, picked,
        auto: (f.autoExtra || []).map(x => x.key), fightingStyle: !!f.fightingStyle, masteries: f.masteries ? atLevel(f.masteries, a.lvl) : 0, optional: !!f.optional };
    });
    const masteries = new Set(c.masteries || []);
    const masteryCount = choiceFeatures.reduce((t, f) => t + (f.masteries || 0), 0);
    if (masteries.size > masteryCount) warnings.push(`Maestrie delle armi: ${masteries.size} su ${masteryCount}.`);

    // Spellcasting: one block per casting class; slots from the multiclass table when 2+ non-pact casters
    const perception = skills.find(s => s.name === 'Perception').total;
    const castings = entries.map(e => ({ e, caster: casterOf(e.cls, e.subcls) })).filter(x => x.caster).map(({ e, caster }) => {
      const cs = spellcasting(c, caster, m, pb, e.level);
      cs.cls = e.key; cs.name = e.subcls && !e.cls.casterFactor ? `${e.cls.name} (${e.subcls.name})` : e.cls.name; cs.level = e.level; cs.factor = caster.factor;
      const acc = spellAccess(c, D, e.key);
      const extra = acc.extra.filter(k => D.spells[k] && (D.spells[k].level === 0 || D.spells[k].level <= cs.maxLevel));
      cs.alwaysPrepared = cs.preparedCaster ? [...new Set(extra)] : [];
      cs.expanded = cs.preparedCaster ? [] : [...new Set(extra)];
      const mine = spellsOf(c, e.key);
      const picked = mine.filter(k => !cs.alwaysPrepared.includes(k)).map(k => D.spells[k]).filter(Boolean);
      const nC = picked.filter(s => s.level === 0).length, nS = picked.length - nC;
      cs.picked = { cantrips: nC, spells: nS };
      if (cs.cantrips && nC > cs.cantrips) warnings.push(`${cs.name}: troppi trucchetti (${nC}/${cs.cantrips}).`);
      const lim = cs.prepared ?? cs.known;
      if (lim != null && !cs.spellbook && nS > lim) warnings.push(`${cs.name}: troppi incantesimi (${nS}/${lim}).`);
      if (cs.schools) {
        cs.offAllowed = [3, 8, 14, 20].filter(l => e.level >= l).length;
        cs.offUsed = picked.filter(sp => sp.level > 0 && !cs.schools.includes(sp.school)).length;
        if (cs.offUsed > cs.offAllowed) warnings.push(`${cs.name}: ${cs.offUsed} incantesimi fuori dalle scuole ammesse (max ${cs.offAllowed} a questo livello).`);
      }
      return cs;
    });
    const slotCasters = entries.map(e => ({ e, caster: casterOf(e.cls, e.subcls) })).filter(x => x.caster && !isPact(x.caster));
    const spellSlots = { slots: [], pact: castings.find(cs => cs.pact)?.pact || null };
    if (slotCasters.length === 1) spellSlots.slots = castings.find(cs => cs.cls === slotCasters[0].e.key).slots;
    else if (slotCasters.length > 1) spellSlots.slots = SLOTS[slotCasters.reduce((t, x) => t + multiCasterLevel(c, x.caster, x.e.level), 0)] || [];
    const casting = castings[0] || null;
    const grants = bonusGrants(c, D, fx, lvl, m, pb);

    // Feat prerequisites: shown; checked by MPMB code when available (see mpmbPrereq)
    slots.forEach(sl => { const f = D.feats[sl.feat]; sl.prerequisite = f?.prerequisite; sl.choices = f?.choices || []; });

    const s = {
      level: lvl, pb, abilities: ab, saves, skills, skillPicks, hp, hitDice, ac, acNote, acParts, acConditional,
      initiative: m[1] + modsFor('skill', 'Init'), speed: speeds.walk, speeds, vision,
      passivePerception: 10 + perception, asi: slots.filter(x => x.kind === 'asi').length, features, casting, castings, spellSlots, grants,
      profs: { armor: ['Leggere', 'Medie', 'Pesanti', 'Scudi'].filter((_, i) => armorProf[i]), weapons: [weaponProf.simple && 'Semplici', weaponProf.martial && 'Da guerra', ...weaponProf.list].filter(Boolean), tools, languages },
      defenses: { resist: [...new Set(fx.dmgres)], adv: [...new Set(fx.adv)], immune: [...new Set(fx.immune)], notes: [...new Set(fx.saveNotes)] },
      actions: fx.actions, limited, notes: fx.calcText.concat(fx.addMod.filter(x => !['skill', 'save'].includes(x.type) && x.text).map(x => ({ text: x.text, from: x.from }))),
      featSlots: slots, choiceFeatures, masteryCount, active: active.map(a => ({ id: a.id, kind: a.kind, name: a.obj.name || a.label, src: a.obj.src })),
      classes: entries.map(e => ({ key: e.key, name: e.cls.name, level: e.level, subKey: e.subKey, subclass: e.subcls?.name, subclassLevel: e.cls.subclassLevel || 3, subclasses: e.cls.subclasses })),
      levels: seq, trait: [race?.trait, sub?.trait].filter(Boolean).join('\n'), warnings,
      title: [entries.map(e => `${e.cls.name} ${e.level}${e.subcls ? ` (${e.subcls.name})` : ''}`).join(' / '), sub?.name || race?.name, bg?.name].filter(Boolean).join(' · '),
    };

    // Attacks: chosen weapons + natural/racial weapon options, then MPMB's own attack code (atkAdd/atkCalc)
    const fightingStyle = name => active.some(a => new RegExp('^' + name, 'i').test(a.obj.name || ''));
    const isProf = w => w.type === 'Natural' || weaponProf.list.includes(String(w.name).toLowerCase()) || (w.type === 'Simple' ? weaponProf.simple : w.type === 'Martial' ? weaponProf.martial : true);
    const attacks = [];
    (c.weapons || []).map(k => [k, D.weapons[k]]).filter(([, w]) => w).forEach(([k, w]) => {
      const finesse = /finesse/i.test(w.desc || '');
      const ranged = w.list === 'ranged';
      const abIdx = w.ability ? w.ability - 1 : finesse ? (m[1] > m[0] ? 1 : 0) : ranged ? 1 : (levelOf('monk') && w.type === 'Simple' ? (m[1] > m[0] ? 1 : 0) : 0);
      attacks.push(makeAttack(w, k, abIdx, isProf(w), masteries.has(k)));
    });
    fx.weaponOptions.filter(w => w.damage && /\d/.test(String(w.damage[0]))).forEach(w => {
      const abIdx = w.ability ? w.ability - 1 : (m[1] > m[0] && /finesse/i.test(w.desc || '') ? 1 : 0);
      attacks.push(makeAttack({ ...w, list: /melee/i.test(w.range || 'melee') ? 'melee' : 'ranged', type: w.type || 'Natural' }, null, abIdx, true, false, w.from));
    });
    function makeAttack(w, key, abIdx, prof, mastery, from) {
      const [n0, d, type] = w.damage;
      // MPMB cantrip dice: "C" = 1/2/3/4 dice at levels 1/5/11/17 ("C×2" doubles)
      const n = /^C/i.test(String(n0)) ? (lvl < 5 ? 1 : lvl < 11 ? 2 : lvl < 17 ? 3 : 4) * (parseFloat(String(n0).split(/[×x*]/)[1]) || 1) : n0;
      const a = { key, name: w.name, w, abIdx, prof, dmgMod: w.abilitytodamage === false ? 0 : m[abIdx], extraHit: 0, extraDmg: 0, die: d === '' || d === undefined ? `${n}` : `${n}d${d}`, type: type || '',
        range: w.range || 'Melee', desc: w.desc || '', dc: w.dc ? 8 + pb + m[abIdx] : null, notes: [], mastery: mastery && w.mastery ? 'Mastery: ' + w.mastery : '' };
      if (from) a.notes.push(from);
      if (w.list === 'ranged' && fightingStyle('Archery') && !hasCode(active, 'atkCalc', /archery/i)) a.extraHit += 2;
      return a;
    }
    // attack cantrips/spells the character knows are attack lines too (MPMB adds them): ability of the class that knows them
    const onList = new Set(c.weapons || []);
    const addSpellAttack = (k, abIdx) => { const w = D.weapons[k]; if (w && w.list === 'spell' && !onList.has(k)) { onList.add(k); attacks.push(makeAttack(w, k, abIdx, true, false)); } };
    castings.forEach(cs => spellsOf(c, cs.cls).concat(cs.alwaysPrepared).forEach(k => addSpellAttack(k, ABIL.indexOf(cs.ability))));
    grants.forEach(g => g.chosen.forEach(k => addSpellAttack(k, g.ability ? ABIL.indexOf(g.ability) : castings[0] ? ABIL.indexOf(castings[0].ability) : 4)));
    runAttackCode(attacks, s, c, D, fx, m, pb);
    s.attacks = attacks.map(a => ({ name: a.name, prof: a.prof, toHit: a.dc ? null : m[a.abIdx] + (a.prof ? pb : 0) + a.extraHit, dc: a.dc,
      damage: `${a.die}${a.dmgMod + a.extraDmg ? sign(a.dmgMod + a.extraDmg) : ''} ${a.type}`.trim(), range: a.range, notes: [a.desc, a.mastery, ...a.notes].filter(Boolean).join(' · ') }));
    runSpellCode(s, c, D, fx, m, pb);
    s.inventory = inventory(c, D, ab.total, race, fx);
    s.wildShape = wildShapeFrom(c, D, entries, fx);
    if (s.wildShape?.known && s.wildShape.chosen.length > s.wildShape.known) warnings.push(`Forme selvatiche conosciute: ${s.wildShape.chosen.length} su ${s.wildShape.known}.`);
    s.companionSlots = companionSlots(c, D, s, fx);
    s.companions = s.companionSlots.map(sl => ({ slot: sl, block: companionBlock(sl, c, D, s) })).filter(x => x.block);
    if (c.companion && D.creatures?.[c.companion]) s.companions.push({ slot: { id: 'free', name: 'Scelta libera (col DM)', from: '' }, block: companionBlock({ kind: 'fixed', key: c.companion, name: D.creatures[c.companion].name }, c, D, s) });
    s.prereqs = prereqReport(s, c, D, ab.total);
    s.prereqs.forEach(p => { if (p.ok === false) warnings.push(`${p.name}: prerequisito non soddisfatto${p.text ? ` (${p.text})` : ''}.`); });
    return s;
  }

  // ---- MPMB compatibility layer ----
  // The sheets' own code (prereqeval, calcChanges atkAdd/atkCalc/spellAdd/spellCalc, extraAC stopeval) runs unchanged against SHIM,
  // a stand-in for the Acrobat document state: classes.known, What("Cha Mod"), CurrentRace/Feats/MagicItems, GetFeatureChoice…
  // MPMB helper functions the code calls (genericSpellDmgEdit…) come from the sheets too (data.helpers). Any failure is ignored:
  // the element then keeps its declarative effects and its explanation text.
  let SHIM = {};
  const SCOPE = typeof Proxy === 'undefined' ? {} : new Proxy({}, {
    has: (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(SHIM, k),
    get: (t, k) => SHIM[k], set: (t, k, v) => { SHIM[k] = v; return true; },
  });
  const compiled = new Map();
  function compileFn(src) {
    if (!src) return null;
    if (!compiled.has(src)) {
      let f = null;
      try { f = Function('S', 'with (S) { return (' + src + '\n); }')(SCOPE); } catch (e) { f = null; }
      compiled.set(src, typeof f === 'function' ? f : null);
    }
    return compiled.get(src);
  }
  const call = (src, ...args) => { const f = compileFn(src); if (!f) return undefined; try { return f(...args); } catch (e) { return undefined; } };
  let helperMemo = null;
  function helpersFor(D) {
    if (helperMemo && helperMemo.D === D) return helperMemo.h;
    const h = {};
    for (const [name, src] of Object.entries(D.helpers || {})) { const f = compileFn(src); if (f) h[name] = f; }
    helperMemo = { D, h };
    return h;
  }
  const docStub = { getField: () => ({ value: '', isBoxChecked: () => 0, display: 0, submitName: '', page: 0 }), info: {}, isWindows: true };
  function setShim(s, c, D) {
    const lvl = s.level, m = s.abilities.mods, total = s.abilities.total;
    const known = {}, cur = {};
    (s.classes || []).forEach(e => {
      const k = baseKey(e.key);
      known[k] = { name: k, level: e.level, subclass: baseKey(e.subKey || '') };
      cur[k] = { name: e.name, subname: e.subclass || '', fullname: e.subclass || e.name, level: e.level };
    });
    const fields = { 'Character Level': lvl, 'Proficiency Bonus': s.pb, AC: s.ac, 'Unit System': 'imperial', Race: D.races[c.race]?.name || '',
      Background: D.backgrounds[c.background]?.name || '', 'Background Feature': D.backgrounds[c.background]?.feature || '', Alignment: c.alignment || '',
      'Class and Levels': s.title, 'Racial Traits': s.trait || '' };
    ABIL.forEach((a, i) => { fields[a] = total[i]; fields[a + ' Mod'] = m[i]; });
    const slots = (s.featSlots || []).filter(x => D.feats[x.feat]);
    const spells = new Set([...(s.castings || []).flatMap(cs => spellsOf(c, cs.cls)), ...(s.grants || []).flatMap(g => g.chosen)].map(baseKey));
    const owners = name => (s.classes || []).filter(e => baseKey(e.key) === name).flatMap((e, i) => [['cls:' + e.key, i === 0 && e.key === c.cls], ['sub:' + e.key, e.key === c.cls]]);
    SHIM = {
      ...helpersFor(D),
      classes: { known, totallevel: lvl, primary: baseKey(c.cls), hd: [], parsed: [] }, CurrentClasses: cur,
      What: f => fields[f] ?? '', How: f => fields[f] ?? '', Who: () => '', Number, isNaN, parseFloat, parseInt, RegExp, Math, String, Array, Object,
      CurrentRace: { known: baseKey(c.race), variant: c.subrace || '', level: lvl, name: D.races[c.race]?.name || '' },
      CurrentFeats: { known: slots.map(x => baseKey(x.feat)), choices: slots.map(x => x.choice || ''), level: lvl },
      CurrentMagicItems: { known: (c.magicItems || []).map(x => baseKey(x.key)), choices: (c.magicItems || []).map(x => x.choice || ''), level: lvl },
      CurrentSpells: {}, CurrentWeapons: { known: (c.weapons || []).map(k => [baseKey(k)]) }, CurrentArmour: { known: baseKey(c.armour || '') },
      GetFeatureChoice: (type, obj, fea, extra) => {
        const t = String(type).toLowerCase();
        const list = /^class/.test(t) ? owners(obj) : /race/.test(t) ? [['race', true], ['subrace', true]] : [];
        for (const [owner, legacy] of list) {
          const v = extra ? extraOf(c, owner, fea, legacy) : choiceOf(c, owner, fea, legacy);
          if (extra ? v.length : v) return extra ? v.slice() : String(v).toLowerCase();
        }
        return extra ? [] : '';
      },
      isMagicItemAttuned: k => (c.magicItems || []).some(x => baseKey(x.key) === k && x.attuned),
      hasSkillProf: sk => { const x = s.skills.find(y => y.name.toLowerCase().startsWith(String(sk).toLowerCase().slice(0, 3))); return [!!x?.prof, !!x?.exp]; },
      isSpellUsed: k => spells.has(k), SpellsList: D.spells, isArray: Array.isArray, tDoc: docStub, app: { alert() {} }, event: {},
      FieldNumbers: { actions: 6, bonusactions: 3, reactions: 2, attacks: 5, limfea: 8 }, typePF: true, typeA4: false, sheetVersion: c.edition === '2024' ? 24001001 : 14001001, levels: Array.from({ length: 20 }, (_, i) => i + 1),
      desc: (arr, j, p) => [].concat(arr).map(x => (p || '') + x).join(j ?? '\n'), toUni: x => x, ConvertToMetric: x => x,
      Value() {}, Hide() {}, Show() {}, SetStringifieds() {}, AskUserOptions() {}, AddString() {}, RemoveString() {}, ReplaceString() {},
    };
    return SHIM;
  }
  // stopeval(v) returns true when the AC bonus does NOT apply
  function runStopeval(src, ctx) {
    if (!src) return undefined;
    const a = ctx.armour, r = call(src, { wearingArmor: !!a, lightArmor: a?.type === 'light', mediumArmor: a?.type === 'medium', heavyArmor: a?.type === 'heavy',
      usingShield: ctx.shield, theArmor: a ? { ...a, type: a.type } : {}, shieldProf: true });
    return r === undefined ? undefined : !r;
  }
  const hasCode = (active, kind, re) => active.some(a => a.obj.code?.[kind] && re.test(a.obj.name || ''));
  // calcChanges.atkAdd(fields, v) then atkCalc(fields, v, output), in MPMB order, for every attack line
  function runAttackCode(attacks, s, c, D, fx, m, pb) {
    const adders = fx.code.filter(x => x.code.atkAdd), calcs = fx.code.filter(x => x.code.atkCalc);
    if (!adders.length && !calcs.length) return;
    setShim(s, c, D);
    for (const a of attacks) {
      const w = a.w, isSpell = w.list === 'spell' || /cantrip|spell/i.test(w.type || '');
      const fields = { Description: a.desc, Damage_Die: a.die, Damage_Type: a.type, Mod: a.abIdx + 1, Range: a.range, Proficiency: a.prof, To_Hit_Bonus: 0, Damage_Bonus: 0 };
      const v = { WeaponName: a.key || String(a.name).toLowerCase(), WeaponTextName: a.name, baseWeaponName: baseKey(a.key || '') || String(a.name).toLowerCase(),
        theWea: { ...w, description: w.desc, ability: a.abIdx + 1 }, isMeleeWeapon: w.list === 'melee', isRangedWeapon: w.list === 'ranged',
        isNaturalWeapon: w.type === 'Natural', isWeapon: !isSpell, isSpell, isDC: !!a.dc, isThrownWeapon: /thrown/i.test(w.desc || ''), isOffHand: false,
        isMagicWeapon: false, thisWeapon: [a.key || '', false, true, isSpell ? a.key : ''], StrDex: m[1] > m[0] ? 2 : 1, pactWeapon: false, pactMag: false,
        extraCritM: 0, CritChance: 20, rangeM: 1, isSpellcaster: !!(s.castings || []).length, hasEldritchBlast: false };
      for (const x of adders) call(x.code.atkAdd, fields, v);
      a.desc = fields.Description; a.die = fields.Damage_Die; a.type = fields.Damage_Type; a.range = fields.Range; a.prof = !!fields.Proficiency;
      if (+fields.Mod >= 1 && +fields.Mod <= 6 && +fields.Mod - 1 !== a.abIdx) { a.abIdx = +fields.Mod - 1; a.dmgMod = w.abilitytodamage === false ? 0 : m[a.abIdx]; if (a.dc) a.dc = 8 + pb + m[a.abIdx]; }
      a.extraHit += +fields.To_Hit_Bonus || 0; a.extraDmg += +fields.Damage_Bonus || 0;
      const out = { prof: a.prof, die: a.die, modToDmg: a.dmgMod !== 0, mod: m[a.abIdx], magic: 0, bHit: 0, bDmg: 0, extraDmg: 0, extraHit: 0 };
      for (const x of calcs) call(x.code.atkCalc, fields, v, out);
      a.extraHit += +out.extraHit || 0; a.extraDmg += +out.extraDmg || 0;
      if (out.die && out.die !== a.die) a.die = out.die;
      if (out.modToDmg === false) a.dmgMod = 0;
      if (v.extraCritM || v.CritChance < 20) a.notes.push(`Critico ${v.CritChance < 20 ? v.CritChance + '–20' : ''}${v.extraCritM ? ` (+${v.extraCritM} dadi)` : ''}`.trim());
    }
  }
  // calcChanges.spellCalc(type, casters, ability) -> bonus to DC/attack/prepared; spellAdd(key, spellObj, caster) rewrites spell texts
  function runSpellCode(s, c, D, fx, m, pb) {
    const calcs = fx.code.filter(x => x.code.spellCalc), adds = fx.code.filter(x => x.code.spellAdd);
    s.spellText = {};
    if (!calcs.length && !adds.length) return;
    setShim(s, c, D);
    for (const cs of s.castings) {
      const who = [baseKey(cs.cls)], abil = ABIL.indexOf(cs.ability) + 1;
      for (const x of calcs) {
        const dc = +call(x.code.spellCalc, 'dc', who, abil) || 0, at = +call(x.code.spellCalc, 'attack', who, abil) || 0, pr = +call(x.code.spellCalc, 'prepare', who, abil) || 0;
        cs.dc += dc; cs.attack += at; if (cs.prepared != null) cs.prepared += pr;
      }
    }
    const keys = [...new Set([...s.castings.flatMap(cs => spellsOf(c, cs.cls).concat(cs.alwaysPrepared).map(k => [k, cs.cls])), ...s.grants.flatMap(g => g.chosen.map(k => [k, '']))].map(x => x.join('|')))].map(x => x.split('|'));
    for (const [k, who] of keys) {
      const sp = D.spells[k];
      if (!sp) continue;
      const obj = { ...sp, description: sp.desc, descriptionFull: sp.desc, components: sp.components, range: sp.range, duration: sp.duration };
      let changed = false;
      for (const x of adds) if (call(x.code.spellAdd, baseKey(k), obj, baseKey(who))) changed = true;
      if (changed && obj.description && obj.description !== sp.desc) s.spellText[k] = obj.description;
    }
  }
  // prereqeval(v) of chosen feats/options: true = met, false/"skip" = not met; no code = not checked (null)
  function prereqV(s, c, D, choice) {
    const profs = s.skills.filter(x => x.prof).map(x => x.name), exps = s.skills.filter(x => x.exp).map(x => x.name);
    const spells = (s.castings || []).flatMap(cs => spellsOf(c, cs.cls)).concat((s.grants || []).flatMap(g => g.chosen)).map(baseKey);
    return { characterLevel: s.level, choice, skillProfs: profs, skillProfsLC: profs.map(x => x.toLowerCase()), skillExpertise: exps, skillExpertiseLC: exps.map(x => x.toLowerCase()),
      toolProfs: (s.profs?.tools || []).map(x => String(x).toLowerCase()), isSpellcaster: !!(s.castings || []).length || spells.length > 0,
      hasEldritchBlast: spells.includes('eldritch blast'), shieldProf: (s.profs?.armor || []).includes('Scudi'), armorProfs: s.profs?.armor || [], weaponProfs: s.profs?.weapons || [] };
  }
  function checkPrereq(obj, s, c, D, choice) {
    const src = obj?.code?.prereqeval;
    if (!src) return null;
    setShim(s, c, D);
    const r = call(src, prereqV(s, c, D, choice));
    return r === undefined ? null : !(r === false || r === 'skip');
  }
  function prereqReport(s, c, D) {
    const out = [];
    (s.featSlots || []).forEach(sl => { const f = D.feats[sl.feat]; if (f) out.push({ name: f.name, text: f.prerequisite, ok: checkPrereq(f, s, c, D) }); });
    (s.choiceFeatures || []).forEach(cf => cf.picked.forEach(k => { const o = cf.extrachoices.find(x => x.key === k); if (o) out.push({ name: o.name, text: o.prereq, ok: checkPrereq(o, s, c, D, k) }); }));
    (c.magicItems || []).forEach(it => { const mi = D.magicItems?.[it.key]; if (mi?.prerequisite) out.push({ name: mi.name, text: mi.prerequisite, ok: checkPrereq(mi, s, c, D) }); });
    return out;
  }

  // MPMB source codes -> books (fallbacks; the add-ons' own SourceList is in data.sources)
  const SOURCES = {
    SRD: { name: 'System Reference Document 5.1', short: 'SRD 5.1', url: 'https://www.dndbeyond.com/srd#SystemReferenceDocumentv51' },
    P: { name: "Player's Handbook (2014)", short: 'PHB 2014' },
    SRD24: { name: 'System Reference Document 5.2.1', short: 'SRD 5.2.1', url: 'https://www.dndbeyond.com/srd#SystemReferenceDocumentv52' },
    PHB24: { name: "Player's Handbook (2024)", short: 'PHB 2024' },
    MToF: { name: "Mordenkainen's Tome of Foes", short: 'MToF' },
    ALbackground: { name: 'Adventurers League — background ufficiali WotC', short: 'AL' },
  };
  // Core rules the engine applies, by edition-independent SRD chapter (no page: MPMB doesn't tag them)
  const CORE_RULES = c => [
    ['Punteggi di caratteristica e modificatori', 'Ability Scores and Modifiers'],
    [{ standard: 'Serie standard', pointbuy: 'Acquisto a punti', roll: 'Tiro 4d6 scartando il più basso', manual: 'Punteggi inseriti a mano' }[c.method] || 'Punteggi', 'Character Creation — Generating Ability Scores'],
    ['Bonus di competenza per livello', 'Proficiency Bonus'],
    ['Punti ferita: massimo al 1° livello, valore fisso ai successivi', 'Hit Points and Hit Dice'],
    ['Classe Armatura (armature, scudo, difesa senza armatura)', 'Armor and Shields / Armor Class'],
    ['Tiri per colpire e danni con le armi', 'Making an Attack / Weapons'],
    ['Tiri salvezza, abilità e percezione passiva', 'Saving Throws / Skills / Passive Checks'],
  ];

  // ---- Source selection (like MPMB's "Select which resources the sheet's automation should use") ----
  // An element is usable if it isn't excluded by itself and at least one of its sources is included (MPMB rule).
  const COLLECTIONS = ['races', 'subraces', 'classes', 'subclasses', 'backgrounds', 'bgVariants', 'feats', 'magicItems', 'armour', 'weapons', 'spells', 'creatures'];
  const defaultExcluded = D => Object.entries(D.sources || {}).filter(([, s]) => s.group === 'Unearthed Arcana').map(([k]) => k);
  // Unknown book codes (cited but not in D.sources, e.g. WGtE) are ignored, as MPMB's parseSource() does
  function isAvailable(item, type, key, c, sources) {
    if ((c.excludedItems || []).includes(type + ':' + key)) return false;
    const known = (item.src || []).filter(([code]) => !sources || sources[code]);
    if (!known.length) return true;
    const ex = c.excludedSources || [];
    return known.some(([code]) => !ex.includes(code));
  }
  let filterMemo = { key: null, value: null };
  // Returns a view of the data with only the usable elements (subclass/variant/option lists pruned too). Memoized on the exclusions.
  function filterData(D, c) {
    const memoKey = JSON.stringify([c.edition, c.excludedSources || [], c.excludedItems || []]);
    if (filterMemo.D === D && filterMemo.key === memoKey) return filterMemo.value;
    const F = { ...D };
    for (const t of COLLECTIONS) F[t] = Object.fromEntries(Object.entries(D[t] || {}).filter(([k, v]) => isAvailable(v, t, k, c, D.sources)));
    // options (fighting styles, invocations…) follow the same rule
    const ok = o => isAvailable(o, 'option', o.key, c, D.sources);
    const pruneFeature = f => (f.choices?.length || f.extrachoices?.length) ? { ...f, choices: (f.choices || []).filter(ok), extrachoices: (f.extrachoices || []).filter(ok) } : f;
    F.classes = Object.fromEntries(Object.entries(F.classes).map(([k, v]) => [k, { ...v, subclasses: v.subclasses.filter(s => F.subclasses[s]), features: (v.features || []).map(pruneFeature) }]));
    F.subclasses = Object.fromEntries(Object.entries(F.subclasses).map(([k, v]) => [k, { ...v, features: (v.features || []).map(pruneFeature) }]));
    F.races = Object.fromEntries(Object.entries(F.races).map(([k, v]) => [k, v.variants ? { ...v, variants: v.variants.filter(x => F.subraces[k + '-' + x]) } : v]));
    filterMemo = { D, key: memoKey, value: F };
    return F;
  }
  // Flat text index for the source lookup: elements + class/subclass/race features and their options, each with its book references
  function searchIndex(D) {
    const idx = [];
    const push = (type, key, it, parent) => idx.push({ type, key, name: it.name || key, parent, src: it.src || [] });
    for (const t of COLLECTIONS) for (const [k, v] of Object.entries(D[t] || {})) {
      push(t, k, v, t === 'subclasses' ? Object.values(D.classes).find(cl => cl.subclasses.includes(k))?.name : t === 'subraces' ? D.races[k.split('-')[0]]?.name : undefined);
      if (['classes', 'subclasses', 'races'].includes(t)) (v.features || []).forEach(f => {
        idx.push({ type: 'feature', key: k + '>' + f.key, name: f.name, parent: v.name, src: f.src || v.src || [], owner: t + ':' + k });
        [...(f.choices || []), ...(f.extrachoices || [])].forEach(o => idx.push({ type: 'option', key: o.key, name: o.name, parent: f.name, src: o.src || f.src || v.src || [] }));
      });
    }
    idx.forEach(e => { e.text = (e.name + ' ' + (e.parent || '')).toLowerCase(); });
    return idx;
  }

  // ---- Mixed campaign (Fonti -> "include the other edition's options"): base edition rules + the other edition's elements ----
  // Other-edition elements get keys suffixed "@24"/"@14" (and " (2024)"/" (2014)" in the name when a namesake exists) and `ed`;
  // references inside them (subclasses, subraces, spell class lists, background feats) are rewritten to the suffixed keys.
  const baseKey = k => String(k || '').replace(/@(14|24)(?=$|-)/, '');
  const mergeMemo = new Map();
  function mergeEditions(Dbase, Dother, otherEd) {
    const memo = mergeMemo.get(otherEd);
    if (memo && memo.a === Dbase && memo.b === Dother) return memo.value;
    const S = '@' + otherEd.slice(2), M = { sources: { ...Dother.sources, ...Dbase.sources } };
    const named = (coll, v) => Object.values(Dbase[coll] || {}).some(x => x.name === v.name) ? { ...v, name: `${v.name} (${otherEd})` } : v;
    const add = (coll, rekey = k => k + S, fix = v => v) => {
      M[coll] = { ...(Dbase[coll] || {}) };
      for (const [k, v] of Object.entries(Dother[coll] || {})) M[coll][rekey(k)] = { ...fix(named(coll, v)), ed: otherEd };
    };
    add('classes', undefined, v => ({ ...v, subclasses: v.subclasses.map(x => x + S) }));
    add('subclasses');
    add('races');
    add('subraces', k => k.replace(/^([^-]+)-/, '$1' + S + '-'));
    add('backgrounds', undefined, v => ({ ...v, feature: v.feature ? v.feature + S : v.feature }));
    add('bgFeatures', undefined, v => v.featsAdd ? { ...v, featsAdd: v.featsAdd.map(f => typeof f === 'string' ? (Dother.feats[f.toLowerCase()] ? f.toLowerCase() + S : f) : f.key && Dother.feats[f.key] ? { ...f, key: f.key + S } : f) } : v);
    add('feats');
    add('armour');
    add('weapons');
    add('magicItems');
    add('creatures');
    add('bgVariants');
    for (const [k, v] of Object.entries(M.backgrounds)) if (v.ed === otherEd && v.variants) M.backgrounds[k] = { ...v, variants: v.variants.map(x => x + S) };
    M.gear = { ...(Dother.gear || {}), ...(Dbase.gear || {}) }; M.packs = { ...(Dother.packs || {}), ...(Dbase.packs || {}) }; M.helpers = Dbase.helpers;
    // spells: each edition's version is learnable by both editions' classes
    const both = cl => cl.flatMap(x => [x, x + S]);
    M.spells = Object.fromEntries(Object.entries(Dbase.spells || {}).map(([k, sp]) => [k, { ...sp, classes: both(sp.classes) }]));
    for (const [k, sp] of Object.entries(Dother.spells || {})) M.spells[k + S] = { ...named('spells', sp), classes: both(sp.classes), ed: otherEd };
    mergeMemo.set(otherEd, { a: Dbase, b: Dother, value: M });
    return M;
  }

  // Bibliography: every rule element this character actually uses, grouped by book, with page numbers
  function bibliography(c, D) {
    const s = compute(c, D), lvl = s.level;
    const { race, sub } = raceOf(c, D);
    const bg = D.backgrounds[c.background];
    const items = [];
    const add = (src, name, kind) => (src || []).forEach(([book, page]) => items.push({ book, page, name, kind }));
    add(race?.src, race?.name, (race?.ed || c.edition) === '2024' ? 'Specie' : 'Razza');
    add(sub?.src, sub?.name, 'Variante');
    classLevels(c, D).entries.forEach(e => { add(e.cls.src, e.cls.name, 'Classe'); if (e.subcls) add(e.subcls.src, e.subcls.name, 'Sottoclasse'); });
    add(bg?.src, bg?.name, 'Background');
    s.features.forEach(f => add(f.src, f.name, f.kind === 'feat' ? 'Talento' : f.source));
    add(D.armour[c.armour]?.src, D.armour[c.armour]?.name, 'Armatura');
    (c.weapons || []).forEach(k => add(D.weapons[k]?.src, D.weapons[k]?.name, 'Arma'));
    const spellKind = k => D.spells[k]?.level ? `Incantesimo ${D.spells[k].level}°` : 'Trucchetto';
    s.castings.forEach(cs => [...spellsOf(c, cs.cls), ...cs.alwaysPrepared].forEach(k => add(D.spells[k]?.src, D.spells[k]?.name, spellKind(k))));
    (c.magicItems || []).forEach(it => add(D.magicItems?.[it.key]?.src, D.magicItems?.[it.key]?.name, 'Oggetto magico'));
    if (c.bgVariant && D.bgVariants?.[c.bgVariant]) add(D.bgVariants[c.bgVariant].src, D.bgVariants[c.bgVariant].name, 'Variante del background');
    s.grants.forEach(g => g.chosen.forEach(k => add(D.spells[k]?.src, D.spells[k]?.name, spellKind(k) + ' (bonus)')));
    const books = {};
    for (const it of items) {
      const ds = D.sources?.[it.book];
      const b = books[it.book] ||= { code: it.book, ...(SOURCES[it.book] || (ds ? { name: ds.name, short: ds.abbr, url: ds.url } : { name: it.book, short: it.book })), entries: [] };
      if (!b.entries.some(e => e.name === it.name && e.page === it.page)) b.entries.push(it);
    }
    Object.values(books).forEach(b => b.entries.sort((x, y) => (x.page || 0) - (y.page || 0) || String(x.name || '').localeCompare(String(y.name || ''))));
    const order = ['SRD24', 'SRD', 'PHB24', 'P'];
    return {
      books: Object.values(books).sort((a, b) => (order.indexOf(a.code) + 1 || 99) - (order.indexOf(b.code) + 1 || 99)),
      core: CORE_RULES(c), coreBook: c.edition === '2024' ? SOURCES.SRD24 : SOURCES.SRD,
    };
  }

  const api = { companionSlots, wildShapeFrom, crNum, classLevels, originRule, checkPrereq, meetsPrereq, mergeEditions, baseKey, canLearn, grantOptions, evalMod, SOURCES, bibliography, filterData, isAvailable, searchIndex, defaultExcluded, ABIL, ABIL_FULL, SKILLS, STANDARD_ARRAY, POINT_COST,
    mod, sign, profBonus, pointBuyCost, parseChoice, backgroundAbilities, descAt, compute, spellOptions };
  if (typeof module !== 'undefined') module.exports = api; else root.MPMB_ENGINE = api;
})(this);
