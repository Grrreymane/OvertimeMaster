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
  const RATE_NAMES = ['大爹贴身带教', '需求反复', '琐事分心', '推进顺畅', '灵感在线'];
  const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const clone = v => JSON.parse(JSON.stringify(v));
  const roundi = x => Math.sign(x) * Math.round(Math.abs(x));
  const clampf = (v, a, b) => Math.min(b, Math.max(a, v));
  const idiv = (a, b) => Math.trunc(a / b);
  const workday = day => (day - 1) % 7 < 5;
  const weekNumber = day => idiv(day - 1, 7) + 1;
  const clock = m => (m < 0 ? '−' : '') + idiv(Math.abs(m), 60) + ':' + String(Math.abs(m) % 60).padStart(2, '0');
  const hours = m => idiv(Math.abs(m), 60) + '小时' + String(Math.abs(m) % 60).padStart(2, '0') + '分';
  const endTime = (start, duration) => { let f = start + duration; if (start <= 720 && f > 720) f += 60; return f; };
  const pt = v => (v / 1000).toFixed(1);
  const SICK_RESET = 30; // 压力满100病倒：当天回家、下一个工作日病假，压力回到这里

  function drawLeaders(seed) {
    const r = new GodotRNG(seed), pool = LEADERS.slice(), out = [];
    for (let i = 0; i < 3; i++) out.push(pool.splice(r.randi_range(0, pool.length - 1), 1)[0]);
    return out;
  }
  function makeWeeklyTraits(seed) {
    const schedule = {}; let previous = [];
    for (let week = 1; week <= 5; week++) {
      let selected = [];
      if (week === 1) selected = drawLeaders(seed);
      else {
        const r = new GodotRNG(seed ^ (week * 0x751AB));
        const pool = LEADERS.filter(id => !previous.includes(id));
        for (let i = 0; i < 3; i++) selected.push(pool.splice(r.randi_range(0, pool.length - 1), 1)[0]);
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
    G.leaderName = () => (G.s.traits || []).map(id => G.leaderData(id).name).join(' / ');
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
        calendar: {}, triggered_leaders: [], rest_minutes: 0, fatigue_peak: 12.0, record_uses: 0, rests_today: 0,
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
    G.submissionBlock = function (points) {
      const s = S();
      if (points === undefined || points < 0) points = s.draft;
      if (points <= 0) return '还没有草稿。先点“工作”做出一些成果。';
      if (G.hasTrait('leader_04') && points < 30000 && !s.small_submit && s.formal + points < TOTAL)
        return '果树农民一次至少收30点草稿，现在只有' + pt(points) + '点。';
      return '';
    };
    G.efficiency = function (month, fatigue) {
      if (month === undefined || month < 0) month = G.s.month;
      if (fatigue === undefined || fatigue < 0) fatigue = G.s.fatigue;
      return clampf(1.0 - balance.monthly_coefficient * month / 60.0 - balance.fatigue_linear * fatigue - balance.fatigue_quadratic * fatigue * fatigue, balance.min_efficiency, 1.0);
    };
    G.fatigueCost = function (kind, overtime) {
      if (kind === 'rest') return 0.0;
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

    function note(msg) { const s = S(); s.last_notice = msg; s.history.push({ day: s.day, time: s.minute, text: msg }); }
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
        note('第' + week + '周领导已更换：' + G.leaderName() + '。三张同时生效。');
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
        s.phase = 'summary'; note('第' + s.day + '日：病假在家，一整天没上班。');
        recordDay();
        if (s.day === 30) endRun('项目没赶上DDL');
        notify(); return;
      }
      note('第' + s.day + '日：' + (s.sealed ? '项目已完成' : RATE_NAMES[s.rate_index] + ' · 产出×' + s.rate.toFixed(2)));
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
      if (G.hasTrait('leader_02') && !s.sealed) s.jobs.push(job('busy', 45, {}, true, '六点晨会'));
      if (s.sealed) {
        s.jobs.push(job('wait', G.minutesUntil(G.earliestDeparture()), {}, false, '项目完成后等待下班'));
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
      s.phase = 'summary'; note('周末两天已合并休息，压力已恢复。'); notify();
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
        note('有人找你：' + s.event.title + '。');
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
            s.jobs.unshift(job('busy', 30, {}, true, '领导留步'));
            note('古风小生叫住了你：多聊30分钟后才能走。');
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
            note(G.submissionBlock()); s.jobs = []; s.phase = 'idle'; return;
          }
          j.kind = 'submit';
          j.left = G.submitMinutes(!!j.payload.use_evidence);
          const waived = G.submissionWaiver(!!j.payload.use_evidence);
          if (s.draft > 0 && waived !== '') { s.evidence -= 1; s.record_uses += 1; note('聊天记录抵消：' + G.leaderData(waived).name + '的一项提交惩罚。'); }
          if (s.draft <= 0) j.left = 0;
          else if (G.hasTrait('leader_07') && !s.first_loss_applied) {
            s.first_loss_applied = true;
            const loss = Math.min(s.draft, 28000);
            s.draft -= loss; s.daily.lost += loss;
            note('文盲要求重写：损失' + pt(loss) + '点未交草稿。');
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
      s.phase = 'idle'; note('已取消未完成安排；已用时间不退还。');
      activate(); checkCollapse(); notify();
    };

    // 推进一个 15 分钟刻
    G.step = function () {
      const s = S();
      if (s.phase !== 'running' || !s.jobs.length) return;
      if (s.minute >= G.shutdownTime()) { depart(true); notify(); return; }
      if (s.minute === 720) {
        s.minute = 780; s.fatigue = Math.max(0, s.fatigue - balance.lunch_recovery);
        note('午休一小时，压力减少' + balance.lunch_recovery + '点。'); checkInterrupts(); notify(); return;
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
        if (s.urgent_active && s.minute <= 1080 && submitted >= s.urgent_goal) { s.urgent_done = true; note('急件已交：赶在18:00前完成了。'); }
        s.formal += submitted; s.draft = 0; s.first_submit = true; s.small_submit = false;
        if (submitted > 0) s.tutorial_submitted = true;
        note('已提交 ' + pt(submitted) + ' 点，项目进度已保存。');
        if (s.formal >= TOTAL) {
          s.sealed = true; s.daily.completed_project = true; s.daily.completed_at = s.minute;
          recordDay(); endRun('项目完成！');
        }
      } else if (j.kind === 'rest') {
        s.fatigue = Math.max(0.0, s.fatigue - G.restRecovery());
        s.rests_today += 1;
        if (G.hasTrait('leader_03') && !s.rest_cleanup) {
          s.rest_cleanup = true;
          s.jobs.unshift(job('busy', 30, {}, true, '整理公共区'));
          note('物业管家安排打扫：休息后多用30分钟。');
        }
      } else if (j.kind === 'hr') {
        s.overtime_ban = true; s.ban_start_day = s.day;
        note('人事约谈完成：本月禁止加班，每天18:00强制下班。');
      } else if (j.kind === 'evidence') {
        s.evidence = Math.min(3, s.evidence + 1); s.crafted += 1;
      }
      if (j.payload && j.payload.gain_evidence) s.evidence = Math.min(3, s.evidence + 1);
      if (j.kind !== 'submit') note('完成：' + G.actionName(j.kind));
    }

    G.actionName = function (kind) {
      return ({ work: '工作', submit: '提交', submit_auto: '提交', rest: '休息', evidence: '存记录', hr: '人事约谈', busy: '处理事务', wait: '等下班', wait_minimum: '等下班' })[kind] || kind;
    };

    function option(label, kind, minutes, cost, loss, fatigue, gain) {
      return { label, kind, minutes: minutes || 0, cost: cost || 0, loss: loss || 0, fatigue: fatigue || 0, gain: !!gain, focus: false, effect: '' };
    }
    function makeEvent(id) {
      const e = { id, title: '', body: '', options: [], forced: false };
      if (id.startsWith('leader_')) {
        const d = G.leaderData(id);
        e.title = d.name + ' · ' + d.event.title; e.body = d.event.body;
        e.speaker_id = id; e.speech = d.event.speech || d.quote;
        for (const o of d.event.options) { const x = option(o.label, o.kind, +o.minutes, +o.cost, +o.loss, +o.fatigue); x.effect = o.effect; e.options.push(x); }
        return e;
      }
      for (const entry of rules.ordinary_events_v03) if (entry.id === id) {
        e.title = entry.title; e.body = entry.body;
        for (const o of entry.options) { const x = option(o.label, o.kind, +o.minutes, +o.cost, +o.loss, +o.fatigue, o.gain); x.effect = o.effect; e.options.push(x); }
      }
      const fixed = {
        E00: ['同事 · 刚才的要求，记得存下来', '聊天记录就是保存下来的工作要求。以后有人改口、让你开会或返工时，可以出示它来省时间、保住草稿。现在先送你1份。',
          [option('保存这份聊天记录 · 不花时间，记录+1', 'busy', 0, 0, 0, 0, true), option('我记住了，先休息一下 · 15分钟，压力−4', 'busy', 15, 0, 0, -4)]],
        E01: ['大爹 · 导出为什么没打印？', '他把鼠标递给你，等你现场讲解这个“简单操作”。',
          [option('现场教他 · 60分钟，压力+8', 'busy', 60, 0, 0, 8), option('发保存的操作教程 · 15分，消耗1份聊天记录', 'busy', 15, 1)]],
        E02: ['大爹 · 我帮你归类了一下', '文件夹确实整齐了，文件却不知道放到哪了。',
          [option('找回文件 · 75分钟', 'busy', 75), option('不找了 · 丢失最多36点草稿', 'busy', 0, 0, 36000), option('恢复副本 · 15分，消耗1份聊天记录', 'busy', 15, 1)]],
        E03: ['大爹 · 工作流按我的习惯来', '他没有用过这个工具，但觉得大家的流程需要统一。',
          [option('参加流程会议 · 90分钟', 'busy', 90), option('拿出签字记录 · 15分，消耗1份聊天记录', 'busy', 15, 1), option('照着改 · 15分 / 最多丢40点', 'busy', 15, 0, 40000)]],
        E04: ['群聊 · 你这里怎么还没完成？', '几分钟前才发过的进度，已经被上面的聊天刷走。',
          [option('重写一份说明 · 15分', 'busy', 15), option('引用聊天记录 · 0分，消耗1份聊天记录', 'busy', 0, 1), option('先忽略 · 今日忙碌额外压力+2/时', 'extra', 0)]],
        E05: ['同事 · 这里有个能用的旧模板', '这次真的有人帮忙。整理好可以留作下次的依据。',
          [option('整理模板 · 30分钟，聊天记录+1', 'busy', 30, 0, 0, 0, true), option('先不用 · 0分', 'busy', 0)]],
        E06: ['服务器 · 临时维护', '大家终于有一个共同认可的无法工作理由。',
          [option('趁机休息 · 30分钟，压力−' + G.restRecovery(), 'rest', 30), option('离线整理资料 · 30分钟，聊天记录+1', 'busy', 30, 0, 0, 0, true)]]
      }[id];
      if (fixed) { e.title = fixed[0]; e.body = fixed[1]; e.options = fixed[2]; }
      return e;
    }
    G.makeEvent = makeEvent;

    function checkHr() {
      const s = S();
      if (s.month <= 2700 || s.hr_month || s.overtime_ban) return;
      s.hr_month = true; s.hr_count += 1; s.fatigue = Math.min(100, s.fatigue + 12);
      s.pending.unshift({ id: 'hr', title: '人事 · 约谈后禁止加班',
        body: '本月加班已超过45小时。约谈完成后，本月每天18:00强制下班；今天已过18:00，会立即离开。手里未提交的草稿会丢失。',
        forced: true, options: [option('接受约谈 · 45分钟，然后强制下班', 'hr', 45), option('提交完整记录 · 15分钟，记录−2，然后强制下班', 'hr', 15, 2)] });
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
          s.pending.push({ id: 'urgent', speaker_id: 'leader_05', speech: '18:00前交给我', title: '顺丰快递 · 18:00前交给我',
            body: '现在16:00。18:00前提交至少' + pt(s.urgent_goal) + '点，就算完成急件；没赶上压力+22。',
            forced: false, options: [option('知道了 · 不花时间', 'busy', 0)] });
        }
        if (s.minute >= 1080 && s.urgent_active && !s.urgent_checked) {
          s.urgent_checked = true;
          if (!s.urgent_done) { s.fatigue = Math.min(100, s.fatigue + 22); note('急件没赶上18:00：压力增加22点。'); }
        }
      }
      if (G.hasTrait('leader_13') && s.minute >= 900 && !s.office_called) {
        s.office_called = true;
        s.pending.push({ id: 'office', speaker_id: 'leader_13', speech: '来我办公室一下', title: '灵魂召唤师 · 来办公室一下',
          body: '刚坐下，办公室的召唤又来了。这次说明要45分钟。', forced: true, options: [option('进行说明 · 45分钟', 'busy', 45)] });
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
      note(e.title + ' → ' + o.label);
      s.event = {}; s.phase = 'idle';
      if (o.minutes > 0) s.jobs.unshift(job(o.kind, o.minutes, { gain_evidence: o.gain }, true, e.title));
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
      note('压力满了，你病倒了：今天提前回家，下一个工作日请病假。');
      recordDay();
      if (s.day === 30) endRun('项目没赶上DDL');
      return true;
    }

    function depart(forced) {
      const s = S();
      if (['summary', 'ending'].includes(s.phase)) return;
      if (s.minute < G.earliestDeparture()) {
        s.phase = 'idle'; s.jobs = []; note(clock(G.earliestDeparture()) + '前还不能下班。'); return;
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
      note(forced ? (G.overtimeBlocked() ? '人事规定禁止加班，强制下班。' : '24:00服务器停机，强制下班。') : '已打卡下班。');
      recordDay();
      if (s.day === 30) endRun(s.formal >= TOTAL ? '项目完成！' : '项目没赶上DDL');
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
      note('月度结局：' + ending);
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

  return { GodotRNG, createGame, drawLeaders, makeWeeklyTraits, makeCalendar, TOTAL, LEADERS, RATES, RATE_NAMES, WEEKDAYS, workday, weekNumber, clock, hours, endTime };
});
