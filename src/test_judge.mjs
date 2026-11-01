// 페르소나 테스트: node test_judge.mjs
import { readFileSync } from 'node:fs';
import { judgeAll, groupByStatus, STATUS } from './judge.js';

const { policies } = JSON.parse(readFileSync(new URL('./policies_v3.json', import.meta.url)));
const { exampleProfiles } = JSON.parse(readFileSync(new URL('./input_schema.json', import.meta.url)));
const TODAY = '2026-11-01';

for (const [label, u] of [['도현 (전입 2025-02-02, ERICA)', exampleProfiles.dohyun],
                          ['전입신고 안 한 ERICA생 (주소 경기도 밖)', exampleProfiles.noRegistration]]) {
  const groups = groupByStatus(judgeAll(policies, u, TODAY));
  console.log(`\n=== ${label} ===`);
  for (const [s, list] of Object.entries(groups)) {
    console.log(`[${STATUS[s]}] ${list.length}건`);
    if (s !== 'eligible') {
      for (const r of list) {
        const why = r.checks.filter((c) => c.state !== 'ok').map((c) => c.text).join(' / ');
        console.log(`  - ${r.id} ${r.name.slice(0, 22)} | ${r.hint} | ${why}`);
      }
    }
  }
  const bonus = judgeAll(policies, u, TODAY).filter((r) => r.bonus && r.checks[0].state === 'ok');
  bonus.forEach((r) => console.log(`  * 가점: ${r.id} ${r.bonus}`));
  const open = judgeAll(policies, u, TODAY).filter((r) => ['open', 'upcoming'].includes(r.recruit.state));
  console.log('  모집 중/예정:', open.map((r) => `${r.id}(${r.statusLabel}, ${r.recruit.label})`).join(', '));
}
