// 의미 검색용 문서 임베딩을 미리 계산한다 (브라우저와 같은 transformers.js·같은 ONNX 파일로 계산해야 값이 맞는다)
//   한 번만:  npm i @huggingface/transformers        (code/v3 에서)
//   실행:     node rag/build_embeddings.mjs [--model ko-sroberta|e5-small] [--no-save]
//   출력:     code/v3/embeddings_v3.json  { model, file, dim, n, ids, data(base64 int8) }  → build_web.py 가 index.html 에 넣는다
// 실행하면 평가 질문(eval_set.json)으로 사업 단위 hit@k 도 같이 출력한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';
import { judgePolicy } from '../judge.js';
import { RAG } from './rag.js';

export const EMBED_MODELS = {
  // 브라우저에서 내려받는 파일 크기가 110~120MB 인 것만. 질문·문서 앞에 붙이는 말은 모델 학습 방식에 맞춘다
  'ko-sroberta': { id: 'jhgan/ko-sroberta-multitask', file: 'model_qint8_avx512_vnni', dtype: 'fp32', q: '', d: '', mb: 111 },
  'e5-small': { id: 'Xenova/multilingual-e5-small', file: 'model', dtype: 'q8', q: 'query: ', d: 'passage: ', mb: 118 },
};
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NAME = arg('--model', 'ko-sroberta'), SAVE = !process.argv.includes('--no-save');
const M = EMBED_MODELS[NAME];
if (process.env.HF_HOME) env.cacheDir = process.env.HF_HOME + '/transformers_js';

const root = new URL('../', import.meta.url);
const { policies } = JSON.parse(readFileSync(new URL('policies_v3.json', root)));
const corpus = JSON.parse(readFileSync(new URL('corpus_v3.json', root)));
const ev = JSON.parse(readFileSync(new URL('eval_set.json', import.meta.url)));

// 문서 글: 청크 본문 + 사업별 검색어 (검색어를 붙이면 바꿔 말한 질문에서 더 잘 맞는다 — results_retrieval.json)
const docText = (c) => {
  if (c.embed) return M.d + c.embed;                 // 범위 밖 예시 청크: 예시 질문 한 문장만 벡터로 만든다
  const kw = c.policyId ? [...corpus.policyMeta[c.policyId].kw, ...corpus.policyMeta[c.policyId].tags] : (c.keywords || []);
  return M.d + c.text + (kw.length ? `\n- 검색어: ${kw.join(', ')}` : '');
};

const t0 = Date.now();
const extract = await pipeline('feature-extraction', M.id, { dtype: M.dtype, model_file_name: M.file });
const loadMs = Date.now() - t0;
async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const t = await extract(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
    const [n, dim] = t.dims;
    for (let r = 0; r < n; r++) out.push(Float32Array.from(t.data.subarray(r * dim, (r + 1) * dim)));
  }
  return out;
}
const t1 = Date.now();
const D = await embed(corpus.chunks.map(docText));
const docMs = Date.now() - t1;
const dim = D[0].length;

// int8 로 줄여서 저장 (정규화된 벡터라 값이 -1~1. 127 을 곱해 반올림)
const q8 = new Int8Array(D.length * dim);
D.forEach((v, i) => v.forEach((x, j) => { q8[i * dim + j] = Math.max(-127, Math.min(127, Math.round(x * 127))); }));
const dq = (i) => { const v = new Float32Array(dim); let n = 0; for (let j = 0; j < dim; j++) { v[j] = q8[i * dim + j] / 127; n += v[j] * v[j]; } n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const Dq = D.map((_, i) => dq(i));

// ---- 평가: 사업 단위 순위 (청크 최고 점수), '이름 연결'을 앞에 두는 방식도 같이 ----
const rag = RAG.create({ corpus, policies, judgePolicy });
const qs = ev.questions.filter((q) => ['fact', 'para', 'help'].includes(q.type) && !q.page);
const t2 = Date.now();
const Q = await embed(qs.map((q) => M.q + q.q));
const qMs = (Date.now() - t2) / qs.length;
const keys = corpus.chunks.map((c) => (c.section === 'oos' ? null : c.policyId || c.id));   // 범위 밖 예시 청크는 사업 순위 표에서 뺀다 (범위 밖 판단은 eval_retrieval.mjs --semantic 에서 잰다)
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function rankUnits(qv, docs) {
  const best = new Map();
  docs.forEach((d, i) => { if (keys[i] == null) return; const s = cos(qv, d); if (!best.has(keys[i]) || s > best.get(keys[i])) best.set(keys[i], s); });
  return [...best].sort((a, b) => b[1] - a[1]);
}
function table(label, rankOf) {
  const row = (sp) => {
    const rs = qs.map((q, i) => [q, rankOf(q, i)]).filter(([q]) => sp === 'all' || q.split === sp);
    const h = (k) => (100 * rs.filter(([, r]) => r <= k).length / rs.length).toFixed(1);
    return `${h(1).padStart(5)} ${h(3).padStart(5)} ${h(5).padStart(5)}`;
  };
  console.log(label.padEnd(34), '| dev', row('dev'), '| test', row('test'), '| hard', row('hard'));
}
const rank = (list, gold) => { const i = list.findIndex(([k]) => gold.includes(k)); return i < 0 ? Infinity : i + 1; };
console.log(`\n${NAME} (${M.id}, ${M.file}.onnx ${M.dtype}) dim=${dim} · 모델 준비 ${(loadMs / 1000).toFixed(1)}s · 문서 ${corpus.chunks.length}개 ${(docMs / 1000).toFixed(1)}s · 질문 ${qMs.toFixed(0)}ms/건`);
console.log('방식'.padEnd(34), '|      hit@1 hit@3 hit@5');
table('임베딩 (실수 그대로)', (q, i) => rank(rankUnits(Q[i], D), q.gold));
table('임베딩 (int8 로 저장한 값)', (q, i) => rank(rankUnits(Q[i], Dq), q.gold));
table('이름 연결 먼저 + 임베딩(int8)', (q, i) => {
  const m = rag.mentions(q.q), list = rankUnits(Q[i], Dq);
  return rank([...m.map((k) => [k, 9]), ...list.filter(([k]) => !m.includes(k))], q.gold);
});

// ---- 답 못함 기준을 잡기 위한 점수 분포 (dev 만 본다) ----
// top: 1위 유사도 / z: 1위가 전체 사업 유사도 분포에서 얼마나 튀는지 (평균에서 표준편차 몇 배)
const all = ev.questions.filter((q) => q.split === 'dev' && !q.page);
const Qa = await embed(all.map((q) => M.q + q.q));
const tops = all.map((q, i) => {
  const list = rankUnits(Qa[i], Dq).map(([, s]) => s);
  const mean = list.reduce((a, b) => a + b, 0) / list.length, sd = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length);
  return { id: q.id, type: q.type, top: list[0], z: (list[0] - mean) / sd, gap: list[0] - list[4] };
});
const by = (ts, f) => tops.filter((t) => ts.includes(t.type)).map((t) => t[f]).sort((a, b) => a - b);
const fmt = (a) => (a.length ? `n=${a.length} 최소 ${a[0].toFixed(2)} 중앙 ${a[a.length >> 1].toFixed(2)} 최대 ${a.at(-1).toFixed(2)}` : '-');
for (const f of ['top', 'z', 'gap']) console.log(`${f.padEnd(4)} (dev) 답해야 하는 질문: ${fmt(by(['fact', 'para', 'help'], f))} | 범위 밖: ${fmt(by(['oos'], f))} | 자료 없음: ${fmt(by(['unans'], f))}`);

if (SAVE) {
  const out = { model: M.id, file: M.file, dtype: M.dtype, queryPrefix: M.q, dim, n: D.length, downloadMB: M.mb, asOf: corpus.asOf,
    ids: corpus.chunks.map((c) => c.id), data: Buffer.from(q8.buffer).toString('base64') };
  writeFileSync(new URL('embeddings_v3.json', root), JSON.stringify(out));
  console.log(`\nembeddings_v3.json 저장 (${(JSON.stringify(out).length / 1024).toFixed(0)}KB)`);
}
