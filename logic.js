// 今天也加班（OvertimeMaster）· 规则层（由 scripts/month.gd 0.12 逐行移植，不碰 DOM）
// 浏览器：<script src="logic.js"> 后用 OvertimeLogic；Node：require('./logic.js')。
// 改成 canvas / 小游戏时，本文件原样复用，只换界面层。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OvertimeLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- Godot 4 RandomNumberGenerator（PCG32）
  // 复盘编号要和 Godot 版抽出同样的领导、天气和事件，所以照搬 Godot 的 RandomPCG。
  const M64 = (1n << 64n) - 1n, MUL = 6364136223846793005n, DEFAULT_INC = 1442695040888963407n;
  class GodotRNG {
    constructor(seed) { this.seed(seed); }
    seed(seed) {
      const s = BigInt.asUintN(64, BigInt(seed));
      this.inc = ((DEFAULT_INC << 1n) | 1n) & M64;
      this.state = 0n; this.next();
      this.state = (this.state + s) & M64; this.next();
    }
    next() {
      const old = this.state;
      this.state = (old * MUL + this.inc) & M64;
      const xs = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
      const rot = Number(old >> 59n);
      return ((xs >>> rot) | (xs << ((-rot) & 31))) >>> 0;
    }
    bounded(bound) {
      const threshold = ((0x100000000 - bound) % bound) >>> 0;
      for (;;) { const r = this.next(); if (r >= threshold) return r % bound; }
    }
    randi_range(a, b) {
      if (a === b) return a;
      return this.bounded(Math.abs(a - b) + 1) + Math.min(a, b);
    }
    randf() {
      const p = this.next();
      if (p === 0) return 0;
      return Math.fround(Math.fround((this.next() | 0x80000001) >>> 0) * Math.pow(2, -32 - Math.clz32(p)));
    }
  }

  // ---------------------------------------------------------------- 常量与小工具
  const TOTAL = 2600000;
  const LEADERS = []; for (let i = 1; i <= 18; i++) LEADERS.push('leader_' + String(i).padStart(2, '0'));
  const RATES = [0.25, 0.4, 0.8, 1.2, 1.7];
  // 给玩家看的文字都是 i18n 键名（mobile/i18n/zh.json），规则层不出现文字本身
  const RATE_NAMES = ['rate.0', 'rate.1', 'rate.2', 'rate.3', 'rate.4'];
  const WEEKDAYS = ['wd.0', 'wd.1', 'wd.2', 'wd.3', 'wd.4', 'wd.5', 'wd.6'];
  const clone = v => JSON.parse(JSON.stringify(v));
  const roundi = x => Math.sign(x) * Math.round(Math.abs(x));
  const clampf = (v, a, b) => Math.min(b, Math.max(a, v));
  const idiv = (a, b) => Math.trunc(a / b);
  const workday = day => (day - 1) % 7 < 5;
  const weekNumber = day => idiv(day - 1, 7) + 1;
  const clock = m => (m < 0 ? '−' : '') + idiv(Math.abs(m), 60) + ':' + String(Math.abs(m) % 60).padStart(2, '0');
  const endTime = (start, duration) => { let f = start + duration; if (start <= 720 && f > 720) f += 60; return f; };
  const pt = v => (v / 1000).toFixed(1);
  // 文字引用 {k: 键名, v: 参数}；参数里也可以再放引用，界面翻译时逐层展开
  const K = (k, v) => v ? { k, v } : { k };
  const LK = (id, f) => K('L.' + id + '.' + f);
  const SICK_RESET = 50; // 压力满100病倒：当天回家、下一个工作日病假，压力回到这里

  // 最烦的一档：qa/balance/leaders.js 推演里“在岗一周”对交付影响最大的 6 位（0.16）。
  // 每周最多抽到其中一位：抽到后，同周剩下的名额从池子里去掉其他最烦的。
  const HARD_LEADERS = ['leader_07', 'leader_05', 'leader_13', 'leader_18', 'leader_12', 'leader_02'];
  function drawThree(r, pool) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const id = pool.splice(r.randi_range(0, pool.length - 1), 1)[0];
      out.push(id);
      if (HARD_LEADERS.includes(id)) for (let k = pool.length - 1; k >= 0; k--) if (HARD_LEADERS.includes(pool[k])) pool.splice(k, 1);
    }
    return out;
  }
  function drawLeaders(seed) {
    return drawThree(new GodotRNG(seed), LEADERS.slice());
  }
  function makeWeeklyTraits(seed) {
    const schedule = {}; let previous = [];
    for (let week = 1; week <= 5; week++) {
      let selected = [];
      if (week === 1) selected = drawLeaders(seed);
      else {
        const r = new GodotRNG(seed ^ (week * 0x751AB));
        selected = drawThree(r, LEADERS.filter(id => !previous.includes(id)));
      }
      schedule[String(week)] = selected; previous = selected;
    }
    return schedule;
  }
  function makeCalendar(seed, weekly) {
    const weather = new GodotRNG(seed ^ 0x17A2B), events = new GodotRNG(seed ^ 0xA8173);
    const cal = {}; let bag = [];
    const swap = (a, i, k) => { const t = a[i]; a[i] = a[k]; a[k] = t; };
    for (let day = 1; day <= 30; day++) {
      if (!workday(day)) continue;
      const roll = weather.randf(); let rateIndex = 4;
      const cuts = [0.08, 0.28, 0.58, 0.85, 1.0];
      for (let i = 0; i < 5; i++) if (roll < cuts[i]) { rateIndex = i; break; }
      if (day === 1 && rateIndex === 0) rateIndex = 2;
      if ((day - 1) % 7 === 0) {
        bag = weekly[String(weekNumber(day))].slice();
        const pool = []; for (let i = 1; i < 16; i++) pool.push('E' + String(i).padStart(2, '0'));
        for (let i = 0; i < (day === 1 ? 1 : 2); i++) bag.push(pool.splice(events.randi_range(0, pool.length - 1), 1)[0]);
        for (let i = bag.length - 1; i > 0; i--) swap(bag, i, events.randi_range(0, i));
        if (day === 29) {
          bag = weekly['5'].slice();
          for (let i = 2; i > 0; i--) swap(bag, i, events.randi_range(0, i));
        }
      }
      // 注意求值顺序和 Godot 一致：先 event（day1 不出袋），再 at
      const ev = day === 1 ? 'E00' : String(bag.shift());
      const at = day === 1 ? 570 : [630, 870, 990][events.randi_range(0, 2)];
      cal[String(day)] = { rate_index: rateIndex, event: ev, at };
    }
    return cal;
  }

  // ---------------------------------------------------------------- 一局游戏
  function createGame(rules) {
    const balance = clone(rules.balance_v10);
    const G = { s: {}, rules, balance, onChange: null };
    const S = () => G.s;

    G.leaderData = function (id) {
      if (!id) id = G.s.leader || 'leader_01';
      return rules.leaders.find(e => e.id === id) || rules.leaders[0];
    };
    G.hasTrait = id => (G.s.traits || []).includes(id);
    G.overtimeBlocked = () => !!G.s.overtime_ban && G.s.day >= (G.s.ban_start_day || 1);
    G.earliestDeparture = () => G.overtimeBlocked() ? 1080 : 1140;
    G.shutdownTime = () => G.overtimeBlocked() ? 1080 : 1440;
    G.minutesUntil = target => Math.max(0, target - G.s.minute - (G.s.minute <= 720 && target > 720 ? 60 : 0));
    G.mentoring = () => { const s = S(); return workday(s.day) && s.rate_index === 0 && !s.sealed && !['summary', 'ending'].includes(s.phase); };

    G.newRun = function (seed) {
      const traits = drawLeaders(seed);
      G.s = {
        version: 1, seed, leader: traits[0], traits, day: 1, minute: 540, month: 0,
        fatigue: 12.0, formal: 0, draft: 0, evidence: 0, crafted: 0, focus: false,
        first_submit: false, phase: 'morning', jobs: [], pending: [], event: {}, hr_month: false,
        hr_count: 0, late_days: 0, tick_count: 0, work_minutes: 0, ledger: [], history: [], daily: {},
        daily_event: '', event_at: 0, event_done: false, extra_fatigue: 0.0, ending: '', sealed: false,
        weekly_traits: makeWeeklyTraits(seed), leader_week: 1, week_changed: false, mentoring_days: 0,
        rate: 0.8, rate_index: 2, last_notice: '', last_lost: 0,
        rest_cleanup: false, small_submit: false, first_loss_applied: false, departure_checked: false,
        pressure: false, pressure_waived: false, first_production: false,
        week_submit_checked: false, week_stress_checked: false,
        urgent_active: false, urgent_done: false, urgent_goal: 10000, urgent_checked: false, office_called: false,
        event_count: 0, tutorial_worked: false, tutorial_submitted: false, overtime_ban: false, ban_start_day: 1,
        calendar: {}, triggered_leaders: [], rest_minutes: 0, fatigue_peak: 12.0, record_uses: 0, rests_today: 0, caught_count: 0,
        sick_next: false, sick_days: 0
      };
      G.s.calendar = makeCalendar(seed, G.s.weekly_traits);
      prepareDay();
    };

    G.productionMultiplier = function (overtime) {
      const s = S();
      let f = overtime && G.hasTrait('leader_16') ? 1.05 : 1.0;
      if (G.hasTrait('leader_06') && s.pressure && !s.pressure_waived) f *= 0.70;
      return f;
    };
    G.evidenceMinutes = () => G.hasTrait('leader_17') && G.s.crafted === 0 ? 60 : 30;
    G.departureDelay = () => G.hasTrait('leader_09') && !G.s.departure_checked && !G.overtimeBlocked() ? 30 : 0;
    G.submissionPenalties = function () {
      const s = S(), p = [];
      for (const id of ['leader_10', 'leader_14']) if (G.hasTrait(id) && !s.week_submit_checked) p.push({ id, minutes: 60 });
      for (const id of ['leader_01', 'leader_11']) if (G.hasTrait(id) && !s.first_submit) p.push({ id, minutes: 30 });
      if (G.hasTrait('leader_15') && !s.week_stress_checked) p.push({ id: 'leader_15', minutes: 0 });
      return p;
    };
    G.submissionWaiver = function (useRecord) {
      const p = G.submissionPenalties();
      return useRecord && G.s.evidence > 0 && p.length ? p[0].id : '';
    };
    G.restRecovery = () => [balance.rest_recovery, balance.rest_repeat_recovery, balance.rest_floor_recovery][Math.min(2, G.s.rests_today)];
    // 摸鱼被抓的概率（rules.json 的 slack_*）：每天第1次安全，第2次、之后各一档；瞄准镜、伏地魔在场各加一点
    G.slackWatchers = () => ['leader_18', 'leader_08'].filter(G.hasTrait);
    G.slackRisk = function () {
      const n = G.s.rests_today;
      if (n === 0) return 0;
      return Math.min(0.8, (n === 1 ? balance.slack_risk_second : balance.slack_risk_later) + balance.slack_watcher_bonus * G.slackWatchers().length);
    };
    // 同一编号、同一天、同一次摸鱼，结果固定（复盘可重现）
    function slackCaught() {
      const s = S(), risk = G.slackRisk();
      if (risk <= 0) return false;
      return new GodotRNG(s.seed ^ (s.day * 0x3C1 + s.rests_today * 0x5F3759)).randf() < risk;
    }
    G.submissionBlock = function (points) {
      const s = S();
      if (points === undefined || points < 0) points = s.draft;
      if (points <= 0) return 'block.noDraft';
      if (G.hasTrait('leader_04') && points < 30000 && !s.small_submit && s.formal + points < TOTAL)
        return 'block.min30'; // 参数 n = 现有草稿点数
      return '';
    };
    G.efficiency = function (month, fatigue) {
      if (month === undefined || month < 0) month = G.s.month;
      if (fatigue === undefined || fatigue < 0) fatigue = G.s.fatigue;
      return clampf(1.0 - balance.monthly_coefficient * month / 60.0 - balance.fatigue_linear * fatigue - balance.fatigue_quadratic * fatigue * fatigue, balance.min_efficiency, 1.0);
    };
    G.fatigueCost = function (kind, overtime) {
      if (kind === 'rest' || kind === 'wait') return 0.0; // 等下班是摸鱼，不涨压力
      let per = overtime ? balance.overtime_fatigue_per_hour : balance.work_fatigue_per_hour;
      if (kind !== 'work') per = overtime ? balance.overtime_busy_fatigue_per_hour : balance.busy_fatigue_per_hour;
      if (kind === 'work' && overtime && G.hasTrait('leader_16')) per += 4.0;
      if (kind === 'work' && G.hasTrait('leader_12')) per += 2.0;
      return (per + G.s.extra_fatigue + (G.mentoring() ? balance.mentoring_extra_fatigue : 0.0)) * 0.25;
    };
    G.projectRemaining = () => Math.max(0, TOTAL - G.s.formal - G.s.draft);
    G.submitMinutes = function (useEvidence) {
      const waived = G.submissionWaiver(useEvidence);
      let d = 15;
      for (const p of G.submissionPenalties()) if (p.id !== waived) d += p.minutes;
      return d;
    };

    // 预估：不改状态，返回结束时刻和预计草稿
    G.preview = function (workMinutes) {
      const s = S();
      let t = s.minute, m = s.month, f = s.fatigue, productive = 0;
      for (let i = 0; i < idiv(workMinutes, 15); i++) {
        if (productive >= G.projectRemaining()) break;
        if (t === 720) { t = 780; f = Math.max(0.0, f - balance.lunch_recovery); }
        if (t >= G.shutdownTime()) break;
        const overtime = t >= 1080;
        const gain = roundi(balance.base_points_per_hour * 250.0 * s.rate * G.efficiency(m, f) * G.productionMultiplier(overtime));
        productive += Math.min(gain, Math.max(0, G.projectRemaining() - productive));
        if (overtime) m += 15;
        f += G.fatigueCost('work', overtime);
        if (i === 0 && gain > 0 && G.hasTrait('leader_18') && !s.first_production) f += 12;
        t += 15;
        f = clampf(f, 0.0, 100.0);
      }
      return { end: t, gain: productive, overtime: m - s.month };
    };

    // 消息存键名和参数，界面显示时再翻译（旧存档里是中文 text 字段）
    function note(key, vars) { const s = S(), m = K(key, vars); s.last_notice = m; s.history.push({ day: s.day, time: s.minute, msg: m }); }
    // 事件标题的引用：有发言领导时前面加领导名
    function eventTitle(e) {
      const tt = K(e.title, e.titleVars);
      return e.speaker_id ? K('fmt.pair', { a: LK(e.speaker_id, 'name'), b: tt }) : tt;
    }
    G.eventTitle = eventTitle;
    function notify() { if (G.onChange) G.onChange(); }
    G.note = note;

    function prepareDay() {
      const s = S();
      s.minute = 540;
      const week = weekNumber(s.day);
      if (week !== s.leader_week) {
        s.traits = s.weekly_traits[String(week)].slice(); s.leader = s.traits[0];
        s.leader_week = week; s.week_changed = !s.sealed;
        s.week_submit_checked = false; s.week_stress_checked = false;
        note('n.week', { week, a: LK(s.traits[0], 'name'), b: LK(s.traits[1], 'name'), c: LK(s.traits[2], 'name') });
      }
      s.crafted = 0; s.rests_today = 0; s.first_submit = false; s.focus = false; s.draft = 0;
      s.extra_fatigue = 0.0; s.phase = 'morning'; s.event = {}; s.event_done = false; s.daily_event = '';
      for (const flag of ['rest_cleanup', 'small_submit', 'first_loss_applied', 'departure_checked', 'pressure', 'pressure_waived', 'first_production', 'urgent_active', 'urgent_done', 'urgent_checked', 'office_called'])
        s[flag] = false;
      s.daily = { day: s.day, workday: workday(s.day), start_formal: s.formal, traits: s.traits.slice(), week: s.leader_week, start_month: s.month, lost: 0, work_minutes: 0 };
      s.triggered_leaders = [];
      if (workday(s.day) && !s.sealed) {
        const entry = s.calendar[String(s.day)];
        s.rate_index = entry.rate_index; s.rate = RATES[s.rate_index];
        if (G.mentoring()) { s.rate = balance.mentoring_rate; s.mentoring_days += 1; }
        s.daily_event = entry.event; s.event_at = entry.at;
      } else { s.rate = 0.0; s.rate_index = 0; }
      s.daily.rate = s.rate;
      if (!workday(s.day)) { settleWeekend(); return; }
      if (s.sick_next && !s.sealed) {
        s.sick_next = false; s.rate = 0.0;
        s.daily.rate = 0.0; s.daily.sick = true; s.daily.departure = 0;
        s.phase = 'summary'; note('n.sickDay', { day: s.day });
        recordDay();
        if (s.day === 30) endRun('end.late');
        notify(); return;
      }
      note(s.sealed ? 'n.daySealed' : 'n.day', { day: s.day, rate: K(RATE_NAMES[s.rate_index]), mult: s.rate.toFixed(2) });
      notify();
    }

    G.acknowledgeWeek = function () {
      const s = S();
      if (s.phase !== 'morning' || !s.week_changed) return false;
      s.week_changed = false; notify(); return true;
    };
    G.beginDay = function () {
      const s = S();
      if (s.phase !== 'morning' || s.week_changed) return false;
      if (!workday(s.day)) { settleWeekend(); notify(); return true; }
      s.phase = 'idle';
      if (G.hasTrait('leader_02') && !s.sealed) s.jobs.push(job('busy', 45, {}, true, 'job.meeting'));
      if (s.sealed) {
        s.jobs.push(job('wait', G.minutesUntil(G.earliestDeparture()), {}, false, 'job.waitDone'));
        s.jobs.push(job('depart', 0));
      }
      activate(); notify(); return true;
    };
    function settleWeekend() {
      const s = S(), first = s.day, before = s.fatigue;
      while (!workday(s.day)) {
        s.daily = { day: s.day, workday: false, start_formal: s.formal, start_month: s.month, lost: 0, work_minutes: 0, departure: 0, rate: 0.0 };
        s.fatigue = Math.max(0, s.fatigue - balance.weekend_recovery_per_day);
        recordDay();
        if (s.day >= 30 || workday(s.day + 1)) break;
        s.day += 1;
      }
      s.daily = { weekend: true, start_day: first, end_day: s.day, recovered: before - s.fatigue, formal_gain: 0, lost: 0, overtime: 0 };
      s.phase = 'summary'; note('n.weekend'); notify();
    }
    function job(kind, minutes, payload, forced, title) {
      return { kind, left: minutes, payload: payload || {}, forced: !!forced, title: title || '', started: false };
    }
    G.canAct = () => G.s.phase === 'idle' && !(G.s.event && G.s.event.id);

    // kind: work / submit / finish_day / discard / rest / evidence / wait
    G.request = function (kind, minutes, useEvidence) {
      const s = S();
      if (!G.canAct()) return false;
      if (minutes === undefined) minutes = 60;
      if (kind === 'work') {
        if (s.sealed || G.projectRemaining() <= 0) return false;
        s.jobs.push(job('work', minutes));
      } else if (kind === 'submit' || kind === 'finish_day') {
        if (s.draft <= 0 && kind === 'submit') return false;
        if (s.draft > 0 && G.submissionBlock() !== '') return false;
        const duration = s.draft > 0 ? G.submitMinutes(useEvidence) : 0;
        const finish = endTime(s.minute, duration);
        if (finish + (kind === 'finish_day' ? G.departureDelay() : 0) > G.shutdownTime()) return false;
        if (s.draft > 0) s.jobs.push(job('submit_auto', 0, { use_evidence: !!useEvidence }));
        if (kind === 'finish_day') { s.jobs.push(job('wait_minimum', 0)); s.jobs.push(job('depart', 0)); }
      } else if (kind === 'discard') {
        if (s.minute < G.earliestDeparture()) return false;
        s.jobs.push(job('depart', 0));
      } else if (kind === 'rest') {
        if (endTime(s.minute, 30) > G.shutdownTime()) return false;
        s.jobs.push(job('rest', 30));
      } else if (kind === 'evidence') {
        if (s.evidence >= 3 || s.crafted >= 2 || endTime(s.minute, G.evidenceMinutes()) > G.shutdownTime()) return false;
        s.jobs.push(job('evidence', G.evidenceMinutes()));
      } else if (kind === 'wait') {
        s.jobs.push(job('wait', minutes));
      } else return false;
      activate(); checkCollapse(); notify(); return true;
    };

    function activate() {
      const s = S();
      if (['morning', 'summary', 'ending', 'choice'].includes(s.phase)) return;
      if (s.pending.length) {
        s.event = s.pending.shift();
        s.event_count += 1;
        if (s.event.id.startsWith('leader_')) {
          s.triggered_leaders.push(s.event.id);
          if (s.event.id === 'leader_08') s.fatigue = Math.min(100, s.fatigue + 18);
          if (s.event.id === 'leader_06' && !s.pressure_waived) s.pressure = true;
        }
        note('n.event', { title: eventTitle(s.event) });
        s.phase = 'choice';
        return;
      }
      let guard = 0;
      while (s.jobs.length && guard < 20) {
        guard += 1;
        const j = s.jobs[0];
        if (j.kind === 'depart') {
          if (G.departureDelay() > 0 && s.minute < 1440) {
            s.departure_checked = true;
            s.jobs.unshift(job('busy', 30, {}, true, 'job.stay'));
            note('n.stay');
            continue;
          }
          s.jobs.shift(); depart(); return;
        }
        if (j.kind === 'wait_minimum') {
          j.kind = 'wait';
          j.left = Math.max(0, G.earliestDeparture() - s.minute - (s.minute <= 720 ? 60 : 0));
        }
        if (j.kind === 'submit_auto') {
          if (s.draft > 0 && G.submissionBlock() !== '') {
            note(G.submissionBlock(), { n: pt(s.draft) }); s.jobs = []; s.phase = 'idle'; return;
          }
          j.kind = 'submit';
          j.left = G.submitMinutes(!!j.payload.use_evidence);
          const waived = G.submissionWaiver(!!j.payload.use_evidence);
          if (s.draft > 0 && waived !== '') { s.evidence -= 1; s.record_uses += 1; note('n.waived', { name: LK(waived, 'name') }); }
          if (s.draft <= 0) j.left = 0;
          else if (G.hasTrait('leader_07') && !s.first_loss_applied) {
            s.first_loss_applied = true;
            const loss = Math.min(s.draft, 28000);
            s.draft -= loss; s.daily.lost += loss;
            note('n.rewrite', { n: pt(loss) });
          }
          if (s.draft > 0 && G.hasTrait('leader_15') && !s.week_stress_checked) {
            s.week_stress_checked = true;
            if (waived !== 'leader_15') s.fatigue = Math.min(100, s.fatigue + 24);
          }
        }
        if (j.left <= 0) { s.jobs.shift(); continue; }
        j.started = true; s.phase = 'running'; return;
      }
      s.phase = 'idle';
    }

    G.cancelPlan = function () {
      const s = S();
      if (!['running', 'idle'].includes(s.phase)) return;
      s.jobs = s.jobs.filter(j => j.forced);
      s.phase = 'idle'; note('n.cancel');
      activate(); checkCollapse(); notify();
    };

    // 推进一个 15 分钟刻
    G.step = function () {
      const s = S();
      if (s.phase !== 'running' || !s.jobs.length) return;
      if (s.minute >= G.shutdownTime()) { depart(true); notify(); return; }
      if (s.minute === 720) {
        s.minute = 780; s.fatigue = Math.max(0, s.fatigue - balance.lunch_recovery);
        note('n.lunch', { n: balance.lunch_recovery }); checkInterrupts(); notify(); return;
      }
      const j = s.jobs[0], overtime = s.minute >= 1080;
      if (j.kind === 'work') {
        const gain = roundi(balance.base_points_per_hour * 250.0 * s.rate * G.efficiency() * G.productionMultiplier(overtime));
        s.draft += Math.min(gain, G.projectRemaining()); s.tutorial_worked = true;
        if (gain > 0 && !s.first_production) {
          s.first_production = true;
          if (G.hasTrait('leader_18')) s.fatigue = Math.min(100, s.fatigue + 12);
        }
        s.work_minutes += 15; s.daily.work_minutes += 15;
      }
      if (j.kind === 'rest') s.rest_minutes += 15;
      s.fatigue = clampf(s.fatigue + G.fatigueCost(j.kind, overtime), 0, 100);
      s.fatigue_peak = Math.max(s.fatigue_peak, s.fatigue);
      if (overtime) s.month += 15;
      s.minute += 15; s.tick_count += 1; j.left -= 15;
      if (j.kind === 'work' && G.projectRemaining() === 0) j.left = 0;
      if (j.left <= 0) { s.jobs.shift(); finishJob(j); }
      if (s.phase === 'ending') { notify(); return; }
      checkHr();
      if (s.minute >= G.shutdownTime()) depart(true);
      else checkInterrupts();
      checkCollapse();
      notify();
    };

    function finishJob(j) {
      const s = S();
      if (j.kind === 'submit') {
        const submitted = s.draft;
        s.week_submit_checked = true;
        if (s.urgent_active && s.minute <= 1080 && submitted >= s.urgent_goal) { s.urgent_done = true; note('n.urgentDone'); }
        s.formal += submitted; s.draft = 0; s.first_submit = true; s.small_submit = false;
        if (submitted > 0) s.tutorial_submitted = true;
        note('n.submitted', { n: pt(submitted) });
        if (s.formal >= TOTAL) {
          s.sealed = true; s.daily.completed_project = true; s.daily.completed_at = s.minute;
          recordDay(); endRun('end.won');
        }
      } else if (j.kind === 'rest') {
        const rec = G.restRecovery();
        // 断网时的休息（safe）不会被抓；快到强制下班也不抓，免得事件被下班清掉
        if (!j.payload.safe && s.minute < G.shutdownTime() && slackCaught()) {
          s.rests_today += 1; s.caught_count = (s.caught_count || 0) + 1;
          const w = G.slackWatchers(), who = w.length ? w[0] : s.traits[0];
          s.pending.unshift({ id: 'caught', speaker_id: who, speech: 'ev.caught.speech', title: 'ev.caught.title',
            body: 'ev.caught.body', forced: true,
            options: [Object.assign(option(K('ev.caught.o0', { min: balance.slack_caught_minutes, n: Math.round(rec / 2) }), 'busy', balance.slack_caught_minutes), { effect: 'slack_half', relief: rec / 2 }),
              Object.assign(option(K('ev.caught.o1', { n: rec }), 'busy', 0, 1), { effect: 'slack_full', relief: rec })] });
          note('n.caught', { name: LK(who, 'name') });
        } else {
          s.fatigue = Math.max(0.0, s.fatigue - rec);
          s.rests_today += 1;
        }
        if (G.hasTrait('leader_03') && !s.rest_cleanup) {
          s.rest_cleanup = true;
          s.jobs.unshift(job('busy', 30, {}, true, 'job.cleanup'));
          note('n.cleanup');
        }
      } else if (j.kind === 'hr') {
        s.overtime_ban = true; s.ban_start_day = s.day;
        note('n.hrDone');
      } else if (j.kind === 'evidence') {
        s.evidence = Math.min(3, s.evidence + 1); s.crafted += 1;
      }
      if (j.payload && j.payload.gain_evidence) s.evidence = Math.min(3, s.evidence + 1);
      if (j.kind !== 'submit') note('n.done', { act: K(G.actionName(j.kind)) });
    }

    G.actionName = function (kind) {
      return 'act.' + ({ submit_auto: 'submit', wait_minimum: 'wait', review: 'busy', extra: 'busy' }[kind] || kind);
    };

    function option(label, kind, minutes, cost, loss, fatigue, gain) {
      return { label, kind, minutes: minutes || 0, cost: cost || 0, loss: loss || 0, fatigue: fatigue || 0, gain: !!gain, focus: false, effect: '' };
    }
    function makeEvent(id) {
      const e = { id, title: '', body: '', options: [], forced: false };
      if (id.startsWith('leader_')) {
        const d = G.leaderData(id);
        e.title = 'R.' + id + '.title'; e.body = 'R.' + id + '.body';
        e.speaker_id = id; e.speech = d.event.speech ? 'R.' + id + '.speech' : 'L.' + id + '.quote';
        d.event.options.forEach((o, i) => { const x = option('R.' + id + '.o' + i, o.kind, +o.minutes, +o.cost, +o.loss, +o.fatigue); x.effect = o.effect; e.options.push(x); });
        return e;
      }
      for (const entry of rules.ordinary_events_v03) if (entry.id === id) {
        e.title = 'R.' + id + '.title'; e.body = 'R.' + id + '.body';
        entry.options.forEach((o, i) => { const x = option('R.' + id + '.o' + i, o.kind, +o.minutes, +o.cost, +o.loss, +o.fatigue, o.gain); x.effect = o.effect; e.options.push(x); });
      }
      const fixed = {
        E00: ['ev.E00.title', 'ev.E00.body',
          [option('ev.E00.o0', 'busy', 0, 0, 0, 0, true), option('ev.E00.o1', 'busy', 15, 0, 0, -4)]],
        E01: ['ev.E01.title', 'ev.E01.body',
          [option('ev.E01.o0', 'busy', 60, 0, 0, 8), option('ev.E01.o1', 'busy', 15, 1)]],
        E02: ['ev.E02.title', 'ev.E02.body',
          [option('ev.E02.o0', 'busy', 75), option('ev.E02.o1', 'busy', 0, 0, 36000), option('ev.E02.o2', 'busy', 15, 1)]],
        E03: ['ev.E03.title', 'ev.E03.body',
          [option('ev.E03.o0', 'busy', 90), option('ev.E03.o1', 'busy', 15, 1), option('ev.E03.o2', 'busy', 15, 0, 40000)]],
        E04: ['ev.E04.title', 'ev.E04.body',
          [option('ev.E04.o0', 'busy', 15), option('ev.E04.o1', 'busy', 0, 1), option('ev.E04.o2', 'extra', 0)]],
        E05: ['ev.E05.title', 'ev.E05.body',
          [option('ev.E05.o0', 'busy', 30, 0, 0, 0, true), option('ev.E05.o1', 'busy', 0)]],
        E06: ['ev.E06.title', 'ev.E06.body',
          [option(K('ev.E06.o0', { n: G.restRecovery() }), 'rest', 30), option('ev.E06.o1', 'busy', 30, 0, 0, 0, true)]]
      }[id];
      if (fixed) { e.title = fixed[0]; e.body = fixed[1]; e.options = fixed[2]; }
      return e;
    }
    G.makeEvent = makeEvent;

    function checkHr() {
      const s = S();
      if (s.month <= 2700 || s.hr_month || s.overtime_ban) return;
      s.hr_month = true; s.hr_count += 1; s.fatigue = Math.min(100, s.fatigue + 12);
      s.pending.unshift({ id: 'hr', title: 'ev.hr.title', body: 'ev.hr.body',
        forced: true, options: [option('ev.hr.o0', 'hr', 45), option('ev.hr.o1', 'hr', 15, 2)] });
    }
    function checkInterrupts() {
      const s = S();
      if (s.minute < G.shutdownTime() && !s.sealed && !s.event_done && s.daily_event !== '' && s.minute >= s.event_at) {
        s.event_done = true; s.pending.push(makeEvent(s.daily_event));
      }
      checkLeaderSchedule();
      s.phase = 'idle';
      activate();
    }
    function checkLeaderSchedule() {
      const s = S();
      if (s.sealed) return;
      if (G.hasTrait('leader_05')) {
        if (s.minute >= 960 && !s.urgent_active) {
          s.urgent_active = true; s.urgent_goal = Math.min(20000, TOTAL - s.formal);
          s.pending.push({ id: 'urgent', speaker_id: 'leader_05', speech: 'ev.urgent.speech', title: 'ev.urgent.speech',
            body: 'ev.urgent.body', bodyVars: { n: pt(s.urgent_goal) },
            forced: false, options: [option('ev.urgent.o0', 'busy', 0)] });
        }
        if (s.minute >= 1080 && s.urgent_active && !s.urgent_checked) {
          s.urgent_checked = true;
          if (!s.urgent_done) { s.fatigue = Math.min(100, s.fatigue + 22); note('n.urgentMiss'); }
        }
      }
      if (G.hasTrait('leader_13') && s.minute >= 900 && !s.office_called) {
        s.office_called = true;
        s.pending.push({ id: 'office', speaker_id: 'leader_13', speech: 'ev.office.speech', title: 'ev.office.title',
          body: 'ev.office.body', forced: true, options: [option('ev.office.o0', 'busy', 45)] });
      }
    }

    G.optionEnabled = function (idx) {
      const s = S();
      if (s.phase !== 'choice' || idx < 0 || idx >= s.event.options.length) return false;
      const o = s.event.options[idx];
      if (s.evidence < o.cost) return false;
      if (o.gain && s.evidence >= 3) return false;
      return true;
    };
    G.choose = function (idx) {
      const s = S();
      if (!G.optionEnabled(idx)) return false;
      const e = s.event, o = e.options[idx];
      s.evidence -= o.cost; s.record_uses += o.cost;
      const loss = Math.min(s.draft, o.loss);
      s.draft -= loss; s.daily.lost += loss;
      s.fatigue = clampf(s.fatigue + o.fatigue, 0.0, 100.0);
      if (o.kind === 'extra') s.extra_fatigue = 2.0;
      if (o.effect === 'small_submit') s.small_submit = true;
      if (o.effect === 'waive_pressure') { s.pressure = false; s.pressure_waived = true; }
      if (o.relief) s.fatigue = Math.max(0.0, s.fatigue - o.relief);
      note('n.choice', { title: eventTitle(e), opt: o.label });
      s.event = {}; s.phase = 'idle';
      if (o.minutes > 0) s.jobs.unshift(job(o.kind, o.minutes, { gain_evidence: o.gain, safe: o.kind === 'rest' }, true, eventTitle(e)));
      else if (o.gain) s.evidence = Math.min(3, s.evidence + 1);
      activate(); checkCollapse(); notify(); return true;
    };

    // 压力满100：病倒。当天立刻回家（没交的草稿丢掉），下一个工作日病假，压力回到 SICK_RESET
    function checkCollapse() {
      const s = S();
      if (s.fatigue < 100 || s.sealed || !['running', 'idle', 'choice'].includes(s.phase)) return false;
      if (s.event && s.event.id === 'hr') s.pending.unshift(s.event);
      s.jobs = s.jobs.filter(j => j.kind === 'hr' && j.left > 0);
      s.pending = s.pending.filter(e => e.id === 'hr');
      s.event = {};
      const lost = s.draft;
      s.last_lost = lost; s.daily.lost += lost; s.draft = 0; s.focus = false;
      s.fatigue = SICK_RESET; s.sick_next = true; s.sick_days = (s.sick_days || 0) + 1;
      s.daily.departure = s.minute; s.daily.collapsed = true; s.daily.sleep = 0;
      s.phase = 'summary';
      note('n.collapse');
      recordDay();
      if (s.day === 30) endRun('end.late');
      return true;
    }

    function depart(forced) {
      const s = S();
      if (['summary', 'ending'].includes(s.phase)) return;
      if (s.minute < G.earliestDeparture()) {
        s.phase = 'idle'; s.jobs = []; note('n.notYet', { time: clock(G.earliestDeparture()) }); return;
      }
      s.jobs = s.jobs.filter(j => ['hr', 'review'].includes(j.kind) && j.left > 0);
      s.pending = s.pending.filter(e => e.id === 'hr');
      s.event = {};
      const lost = s.draft;
      s.last_lost = lost; s.daily.lost += lost; s.draft = 0; s.focus = false;
      if (s.minute > 1410) s.late_days += 1;
      const sleep = s.minute <= 1320 ? balance.sleep_early : (s.minute <= 1410 ? balance.sleep_late : balance.sleep_very_late);
      s.fatigue = Math.max(0.0, s.fatigue - sleep);
      s.daily.departure = s.minute; s.daily.forced_shutdown = !!forced; s.daily.hr_departure = !!forced && G.overtimeBlocked();
      s.daily.sleep = sleep;
      s.phase = 'summary';
      note(forced ? (G.overtimeBlocked() ? 'n.hrOut' : 'n.shutdown') : 'n.out');
      recordDay();
      if (s.day === 30) endRun(s.formal >= TOTAL ? 'end.won' : 'end.late');
    }
    function recordDay() {
      const s = S();
      s.daily.formal_gain = s.formal - s.daily.start_formal;
      s.daily.overtime = s.month - s.daily.start_month;
      s.daily.fatigue_after_sleep = s.fatigue;
      s.ledger.push(clone(s.daily));
    }
    G.nextDay = function () {
      const s = S();
      if (s.phase !== 'summary' || s.day >= 30) return false;
      s.day += 1; prepareDay(); return true;
    };
    function endRun(ending) {
      const s = S();
      s.ending = ending; s.phase = 'ending'; s.jobs = []; s.pending = []; s.event = {};
      note('n.ending', { end: K(ending) });
    }

    G.validate = function () {
      const s = S(), errors = [];
      if (!s.day) return errors;
      if (s.month < 0) errors.push('overtime');
      if (s.minute > 1440 || s.minute < 540) errors.push('clock');
      if (s.day < 1 || s.day > 30) errors.push('calendar');
      if (s.formal < 0 || s.formal > TOTAL || s.draft < 0 || s.formal + s.draft > TOTAL) errors.push('progress');
      if (s.evidence < 0 || s.evidence > 3 || s.crafted > 2) errors.push('evidence');
      if (!(s.fatigue >= 0 && s.fatigue <= 100)) errors.push('fatigue');
      return errors;
    };
    G.load = function (data) {
      if (!data || data.version !== 1 || !Array.isArray(data.traits) || data.traits.length !== 3) return false;
      const prev = G.s; G.s = data;
      if (G.validate().length) { G.s = prev; return false; }
      return true;
    };
    return G;
  }

  return { GodotRNG, HARD_LEADERS, createGame, drawLeaders, makeWeeklyTraits, makeCalendar, TOTAL, LEADERS, RATES, RATE_NAMES, WEEKDAYS, workday, weekNumber, clock, endTime, K };
});
