/**
 * 안산시 청년 혜택 알리미 — 판정 엔진 v3 (브라우저/Node 공용, 의존성 없음)
 *
 * judgeAll(policies, profile, today) → 정책별 결과 배열
 *   policies : policies_v3.json 의 policies 배열
 *   profile  : input_schema.json 의 필드로 만든 사용자 입력 객체
 *   today    : 'YYYY-MM-DD' (생략 시 오늘)
 *
 * 판정하는 조건: 거주 요건(R1·R2·R4·R6·R7·R8·R10) + 나이
 * 판정하지 않는 조건: 소득·취업·학적·주거 → otherConditions 로 "본인 확인" 목록에 표시
 */

export const STATUS = {
  eligible: '충족',
  eligible_from: '날짜 이후 충족',
  eligible_if_move_in: '전입신고하면 충족',
  check: '확인 필요',
  ineligible: '미충족',
};

// ---------- 날짜 유틸 (모두 UTC 기준 'YYYY-MM-DD' 문자열) ----------
const toDate = (s) => new Date(s + 'T00:00:00Z');
const fmt = (d) => d.toISOString().slice(0, 10);
const addYears = (s, n) => {
  const d = toDate(s);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return fmt(d);
};
const addDays = (s, n) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return fmt(d);
};
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const yearsBetween = (a, b) => daysBetween(a, b) / 365.25;
const maxDate = (...ds) => ds.filter(Boolean).sort().at(-1) || null;
const todayStr = () => fmt(new Date());

// 만 나이
function ageOn(birth, on) {
  const b = toDate(birth), d = toDate(on);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    d.getUTCMonth() < b.getUTCMonth() ||
    (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

// ---------- 거주 요건 ----------
// 반환: { state: 'ok'|'from'|'move_in'|'check'|'no', from?, text, hint? }
function judgeResidence(res, u, today) {
  const reg = u.ansanRegistered === true;
  const moveIn = reg ? u.ansanMoveInDate : null;
  const zones = u.lifeZones || [];

  switch (res.type) {
    case 'R7':
      return { state: 'ok', text: '거주 조건 없음' };

    case 'R1': {
      const note = res.basisAssumed ? ' (원문에 기준일이 없어 신청일 기준으로 가정)' : '';
      return reg
        ? { state: 'ok', text: `${res.basis} 기준 안산 주민등록 필요 → 있음${note}` }
        : { state: 'move_in', text: '안산 주민등록 필요 → 없음', hint: '안산으로 전입신고하면 바로 충족' };
    }

    case 'R2': {
      const cont = res.minContinuousYears, cum = res.minCumulativeYears;
      const need = cum ? `연속 ${cont}년 또는 합산 ${cum}년` : `연속 ${cont}년`;
      if (!reg) {
        return { state: 'no', text: `안산 거주기간 ${need} 필요 → 주민등록 없음`,
                 hint: `전입신고 후 ${cont}년 거주하면 충족` };
      }
      const prior = Number(u.ansanPriorYears) || 0;
      const contYears = yearsBetween(moveIn, today);
      const contDate = addYears(moveIn, cont);                                  // 연속 요건 충족일
      const cumDate = cum ? addDays(moveIn, Math.max(0, cum - prior) * 365.25) : null; // 합산 요건 충족일(근사)
      const okDate = [contDate, cumDate].filter(Boolean).sort()[0];
      const now = `안산 연속 ${contYears.toFixed(1)}년` + (prior ? ` + 이전 ${prior}년` : '');
      if (okDate <= today) return { state: 'ok', text: `${need} 필요 → ${now}` };
      return { state: 'from', from: okDate, text: `${need} 필요 → ${now}`,
               hint: `${okDate}부터 충족 (그때 공고 기준)` };
    }

    case 'R4': {
      if (!reg) {
        return { state: 'no', text: '안산 주민등록 + 경기도 거주기간 필요 → 안산 주민등록 없음',
                 hint: '안산 전입 후 경기도 거주 3년이 되면 충족' };
      }
      const gStart = u.gyeonggiBeforeAnsan && u.gyeonggiSinceDate ? u.gyeonggiSinceDate : moveIn;
      const okDate = addYears(gStart, res.minContinuousYears);
      const now = `경기도 연속 ${yearsBetween(gStart, today).toFixed(1)}년`;
      const need = `안산 주민등록 + 경기도 연속 ${res.minContinuousYears}년`;
      if (okDate <= today) return { state: 'ok', text: `${need} 필요 → ${now}` };
      return { state: 'from', from: okDate, text: `${need} 필요 → ${now}`,
               hint: `${okDate}부터 거주 요건 충족` };
    }

    case 'R6': {
      if (reg) return { state: 'ok', text: '안산 주민등록 있음' };
      const hit = (res.altZones || []).filter((z) => zones.includes(z));
      if (hit.length) {
        return { state: 'ok', text: `주민등록 없어도 안산 소재 ${hit.join('·')}(으)로 인정` };
      }
      return { state: 'move_in',
               text: `안산 주민등록 또는 안산 소재 ${res.altZones.join('·')} 필요 → 없음`,
               hint: '전입신고하면 충족' };
    }

    case 'R8': {
      if (reg) return { state: 'ok', text: '경기도 거주 필요 → 안산(경기도) 주민등록 있음' };
      if (u.currentRegion === 'gyeonggi') return { state: 'ok', text: '경기도 거주 필요 → 경기도 주민등록 있음' };
      if (u.currentRegion === 'other') {
        return { state: 'move_in', text: '경기도 거주 필요 → 경기도 밖 주민등록', hint: '안산(경기도)으로 전입신고하면 충족' };
      }
      return { state: 'check', text: '경기도 거주 필요 → 현재 주민등록 지역 미입력', hint: '주민등록 지역을 입력하면 판정돼요' };
    }

    case 'R10':
      return reg
        ? { state: 'no', text: '안산 외 지역 주민등록자만 신청 가능 → 안산 주민등록 있음', hint: '안산 시민은 신청할 수 없는 사업이에요' }
        : { state: 'ok', text: '안산 외 지역 주민등록자 대상 → 해당' };

    default:
      return { state: 'check', text: '유형 미분류' };
  }
}

// ---------- 나이 ----------
// 반환: { state: 'ok'|'from'|'no', from?, lastDay?, text, hint? }
function judgeAge(age, birth, today) {
  const { min, max } = age;
  if (min == null && max == null) return { state: 'ok', text: '나이 제한 없음' };
  const range = min != null && max != null ? (min === max ? `${min}세` : `${min}~${max}세`)
    : min != null ? `${min}세 이상` : `${max}세 이하`;
  const now = ageOn(birth, today);
  const lastDay = max != null ? addDays(addYears(birth, max + 1), -1) : null; // 상한 나이의 마지막 날
  if (max != null && now > max) {
    return { state: 'no', text: `만 ${range} → 지금 만 ${now}세`, hint: '나이 상한 초과' };
  }
  if (min != null && now < min) {
    const from = addYears(birth, min);
    return { state: 'from', from, lastDay, text: `만 ${range} → 지금 만 ${now}세`, hint: `${from}부터 나이 충족` };
  }
  return { state: 'ok', lastDay, text: `만 ${range} → 지금 만 ${now}세` };
}

// ---------- 모집 상태 ----------
function recruitState(apply, today) {
  const { start, end, periodText = '' } = apply;
  if (/종료|완료|중단/.test(periodText) && !(start && end && today <= end)) {
    return { state: 'closed', label: '모집 종료', note: periodText };
  }
  if (start && end) {
    if (today < start) return { state: 'upcoming', label: `접수 D-${daysBetween(today, start)}`, dday: daysBetween(today, start) };
    if (today <= end) return { state: 'open', label: `마감 D-${daysBetween(today, end)}`, dday: daysBetween(today, end) };
    return { state: 'closed', label: '이번 모집 마감', note: periodText };
  }
  if (/상시|연중/.test(periodText)) return { state: 'always', label: '상시' };
  if (start && today >= start) return { state: 'always', label: '상시' };
  return { state: 'unknown', label: '공고 확인', note: periodText };
}

// ---------- 거주 가점 ----------
function bonusNote(bonus, u, today) {
  if (!bonus) return null;
  if (!bonus.years || u.ansanRegistered !== true) return bonus.text;
  const y = yearsBetween(u.ansanMoveInDate, today);
  const next = bonus.years.find((n) => y < n);
  const got = bonus.years.filter((n) => y >= n).at(-1);
  const parts = [got ? `안산 ${got}년 이상 가점 해당` : `가점 기준 미달 (안산 ${y.toFixed(1)}년)`];
  if (next) parts.push(`${addYears(u.ansanMoveInDate, next)}부터 ${next}년 가점`);
  return parts.join(' · ');
}

// ---------- 정책 하나 판정 ----------
export function judgePolicy(p, u, today = todayStr()) {
  const res = judgeResidence(p.residence, u, today);
  const age = judgeAge(p.age, u.birthDate, today);

  let status, eligibleFrom = null, hint = '';
  if (res.state === 'no' || age.state === 'no') {
    status = 'ineligible';
    hint = res.state === 'no' ? res.hint : age.hint;
  } else if (res.state === 'check') {
    status = 'check';
    hint = res.hint;
  } else if (res.state === 'move_in') {
    status = 'eligible_if_move_in';
    hint = res.hint + (age.state === 'from' ? ` (나이는 ${age.from}부터 충족)` : '');
  } else if (res.state === 'from' || age.state === 'from') {
    const start = maxDate(res.from, age.from);
    if (age.lastDay && start > age.lastDay) {
      status = 'ineligible';
      hint = `${start}에 요건을 채우지만 그때는 나이 상한을 넘어요`;
    } else {
      status = 'eligible_from';
      eligibleFrom = start;
      hint = `${start}부터 충족`;
    }
  } else {
    status = 'eligible';
  }

  return {
    id: p.id,
    name: p.name,
    status,
    statusLabel: status === 'eligible_from' ? `${eligibleFrom}부터 충족` : STATUS[status],
    eligibleFrom,
    hint,
    checks: [
      { key: 'residence', label: `거주 (${p.residence.type} ${p.residence.label})`, state: res.state, text: res.text },
      { key: 'age', label: '나이', state: age.state, text: age.text },
    ],
    selfCheck: p.otherConditions,          // 본인이 확인해야 하는 조건(판정 안 함)
    bonus: bonusNote(p.bonus, u, today),
    recruit: recruitState(p.apply, today),
    evidence: p.evidence,
    sourceUrl: p.sourceUrl,
  };
}

// ---------- 전체 판정 + 화면용 그룹 ----------
export function judgeAll(policies, u, today = todayStr()) {
  return policies.map((p) => judgePolicy(p, u, today));
}

const ORDER = ['eligible', 'eligible_if_move_in', 'eligible_from', 'check', 'ineligible'];
export function groupByStatus(results) {
  const groups = Object.fromEntries(ORDER.map((s) => [s, []]));
  results.forEach((r) => groups[r.status].push(r));
  // 그룹 안에서는 모집 중(마감 임박 순) → 접수 예정 → 상시 → 나머지
  const rank = (r) => ({ open: 0, upcoming: 1, always: 2, unknown: 3, closed: 4 }[r.recruit.state]);
  for (const s of ORDER) groups[s].sort((a, b) => rank(a) - rank(b) || (a.recruit.dday ?? 999) - (b.recruit.dday ?? 999));
  return groups;
}
