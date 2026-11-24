/**
 * 안산시 청년 혜택 알리미 — 공고문 질의응답(RAG) 엔진 v2 (브라우저/Node 공용, 의존성 없음)
 *
 * const rag = RAG.create({ corpus, policies, judgePolicy });
 * const a = rag.answer('청년월세 얼마 받아요?', { profile, today, page });
 *   a.text     : 모델 없이 만든 답 (검색한 청크를 그대로 이어 붙인 문장)
 *   a.sources  : 답에 쓴 청크 (출처 카드용)
 *   a.llm      : 소형 언어모델에 넘길 프롬프트 { use, system, user }  ← 모델은 이 자료만 보고 말투를 다듬는다
 *   a.abstain  : 수집한 자료로 답할 수 없다고 판단한 경우 true
 *
 * 역할 분담 (01 문서): 자격 판정은 judge.js 가 한다. 이 파일은 판정 결과를 '자료'로 받아 설명만 한다.
 *   1) 질문 분류(규칙)  2) 검색(BM25: 낱말 + 글자 2-gram + 사업별 검색어)  3) 답 조립  4) 모델용 프롬프트
 *
 * v2 (2026-11-24 2차): 범위 밖 예시 문서(section 'oos')로 "다루지 않는 질문"을 가려내고, 확신이 없으면 거절 대신 가까운 사업 후보를 보여 준다.
 *   새 질문 유형: 두 사업 비교 / 조건을 붙인 질문(휴학하면, 같이 살아도) / 나이를 말한 질문(서른 살도?) / 인사.  a.debug.route 에 답이 나온 길을 남긴다.
 */
export const RAG = (() => {
  // ============================================================
  // 1. 토큰화
  // ============================================================
  const JOSA = ['에서는', '으로는', '에게는', '이라는', '이라고', '한테는', '까지는', '부터는', '에서도', '으로도',
    '에서', '에게', '한테', '으로', '까지', '부터', '처럼', '보다', '이랑', '하고', '이나', '이란', '에는', '에도', '은요', '는요',
    '은', '는', '이', '가', '을', '를', '에', '의', '도', '로', '와', '과', '만', '랑', '요'];
  // 뜻이 없는 말(질문 꼬리·대명사). 의도 파악은 원문으로 따로 하므로 검색에서는 뺀다
  const STOP = new Set(['뭐', '뭘', '뭐가', '뭔가', '무엇', '어떻게', '어디', '어디서', '언제', '얼마', '얼마나', '어떤', '어느', '왜',
    '있어요', '있나요', '있어', '있을까요', '있는', '있는지', '없나요', '없어요', '알려줘', '알려주세요', '알려줘요', '해요', '하나요', '돼요', '되나요',
    '수', '것', '거', '게', '데', '좀', '같은', '그', '이', '저', '나', '내', '제', '저는', '나는', '내가', '제가', '나도', '저도',
    '인가요', '예요', '이에요', '할', '하는', '한', '하면', '싶어', '싶어요', '관련', '관련해서', '대해', '대해서', '종류', '이거', '이건', '여기', '그거',
    '받을', '받는', '받아요', '주는', '되는', '되면', '때', '중', '및', '등', '또는', '혹시', '지금', '요즘', '오늘', '무슨', '뜻', '뜻이에요', '어때', '어때요']);
  // 표기를 하나로 맞추기 (양쪽에 똑같이 적용). '서른 살'·'스물네 살' 같은 우리말 나이는 숫자로 바꾼다
  const KCNT = { '하나': 1, '둘': 2, '셋': 3, '넷': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9 };
  const KTEN = { '열': 10, '스무': 20, '스물': 20, '서른': 30, '마흔': 40 }, KONE = { '한': 1, '두': 2, '세': 3, '네': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9 };
  const REWRITE = [
    [/전\s*[·ㆍ・.]?\s*월세/g, '전월세'], [/이스포츠/g, 'e스포츠'], [/3\s*d\s*프린터/gi, '3d프린터'], [/중개\s*수수료/g, '중개보수 중개수수료'],
    [/(열|스무|스물|서른|마흔)\s*(한|두|세|네|다섯|여섯|일곱|여덟|아홉)?\s*살/g, (m, t, o) => `${KTEN[t] + (o ? KONE[o] : 0)}세`],
    [/(열|스물|서른|마흔)\s*(하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉)(?=\s*(인데|이에|이고|이야|입니|이면|이라|인\s|$))/g, (m, t, o) => `${KTEN[t] + KCNT[o]}세`], [/(\d+)\s*살/g, '$1세'],
    [/아르바이트/g, '알바'], [/시청에서\s*일/g, '행정체험 시청 일'],
  ];
  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[ㆍ・]/g, '·');
  const compact = (s) => norm(s).replace(/[^a-z0-9가-힣]/g, '');
  function rewrite(s) { let t = norm(s); for (const [re, to] of REWRITE) t = t.replace(re, to); return t; }
  // '신청해요·신청하려면·모집하는' → '신청·모집' (명사 + 하다/되다 꼬리)
  const VERB_END = ['해주세요', '해줄래요', '해줄래', '해줘요', '해줘', '하려면', '하나요', '합니다', '했어요', '하는데', '하세요', '해야', '해요', '해서', '하는', '하면', '하고', '하기', '할', '한', '해',
    '되나요', '됩니다', '됐어요', '돼요', '되는', '되면', '된', '돼'];
  function stem(w) {
    for (const j of VERB_END) if (w.length - j.length >= 2 && w.endsWith(j)) return w.slice(0, -j.length);
    for (const j of JOSA) if (w.length - j.length >= 2 && w.endsWith(j)) return w.slice(0, -j.length);
    return w;
  }
  // 낱말 토큰: 영문·숫자·한글 덩어리. 한글은 조사를 한 겹 뗀다
  function wordTokens(text) {
    const out = [];
    for (const w of rewrite(text).match(/[a-z]+|[0-9]+(?:[.,][0-9]+)*|[가-힣]+/g) || []) {
      if (/^[가-힣]/.test(w)) { if (!STOP.has(w)) { const s = stem(w); if (!STOP.has(s)) out.push(s); } }
      else out.push(w.replace(/,/g, ''));
    }
    return out;
  }
  // 글자 2-gram: 띄어쓰기·활용이 달라도 걸리게 ('월세지원' ↔ '월세 지원', '빌려주는' ↔ '빌려')
  function bigrams(words) {
    const out = [];
    for (const w of words) if (/^[가-힣]{2,}$/.test(w)) for (let i = 0; i < w.length - 1; i++) out.push('§' + w.slice(i, i + 2));
    return out;
  }
  function tokenize(text, useBigram = true) {
    const w = wordTokens(text);
    return useBigram ? w.concat(bigrams(w)) : w;
  }

  // ============================================================
  // 2. BM25 색인 (필드 가중: 사업명·본문·검색어)
  // ============================================================
  const K1 = 1.2, B = 0.6, BIGRAM_W = 0.45;
  function buildIndex(docs, opt = {}) {
    const fw = { title: 1.5, body: 1.0, kw: 1.3, ...(opt.fieldWeights || {}) };
    const useBigram = opt.bigram !== false;
    const postings = new Map();           // token → Map(docIdx → 가중 tf)
    const len = new Float64Array(docs.length);
    docs.forEach((d, i) => {
      for (const [f, text] of Object.entries(d.fields)) {
        if (!text || !fw[f]) continue;
        for (const t of tokenize(text, useBigram)) {
          let m = postings.get(t); if (!m) postings.set(t, (m = new Map()));
          m.set(i, (m.get(i) || 0) + fw[f]);
          len[i] += fw[f];
        }
      }
    });
    // idf 와 평균 길이는 '범위 안' 문서(사업·도움말)로만 계산한다 → 범위 밖 예시 문서를 늘려도 기존 점수와 기준이 흔들리지 않는다
    const inN = docs.filter((d) => !d.oos).length || docs.length;
    let inLen = 0; docs.forEach((d, i) => { if (!d.oos) inLen += len[i]; });
    const avg = inLen / Math.max(1, inN);
    const idf = new Map(), dfIn = new Map();
    for (const [t, m] of postings) { let n = 0; for (const i of m.keys()) if (!docs[i].oos) n++; dfIn.set(t, n); idf.set(t, Math.log(1 + (inN - n + 0.5) / (n + 0.5))); }
    return { docs, postings, len, avg, idf, dfIn, inN, useBigram };
  }
  function scoreAll(index, query) {
    const scores = new Float64Array(index.docs.length);
    const qt = new Map();
    for (const t of tokenize(query, index.useBigram)) qt.set(t, (qt.get(t) || 0) + 1);
    for (const [t] of qt) {
      const m = index.postings.get(t); if (!m) continue;
      const w = index.idf.get(t) * (t[0] === '§' ? BIGRAM_W : 1);
      for (const [i, tf] of m) scores[i] += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * index.len[i] / index.avg));
    }
    return scores;
  }

  // ============================================================
  // 3. 질문 분류에 쓰는 사전
  // ============================================================
  const SECTION_LABEL = { overview: '개요', target: '지원 대상', benefit: '지원 내용', period: '신청 기간', method: '신청 방법', contact: '문의처', notes: '참고', full: '공고 원문', help: '도움말', oos: '다루지 않는 범위' };
  // 묻는 항목 → 섹션. 위에서부터 먼저 맞는 것을 쓴다
  const SECTION_RULES = [
    ['contact', /문의|전화|연락처|담당|부서/],
    ['method', /어디(서|에|로)\s*(신청|접수|지원|해|하)|신청\s*(은|는)?\s*(어디|어떻게)|어떻게\s*(신청|접수|지원)|신청\s*(방법|하려면|하는 ?법|절차)|접수\s*(방법|처)|신청\s*사이트/],
    ['target', /몇\s*(살|세)|나이|연령|누가|누구|대상|자격|조건|소득|재산|휴학|재학|졸업|대학원|학생도|사람도|직장인도|외국인|주민등록|전입|거주|몇\s*년\s*(살|거주)|살아야|가점|우대/],
    ['period', /언제|기간|마감|모집|접수|일정|며칠|날짜|올해|내년|다음/],
    ['benefit', /얼마|금액|지원금|수당|상금|시급|한도|많이\s*(받|줘|주|나오)|몇\s*(번|회|개월)|뭘\s*(지원|해|줘|받)|무엇을|뭐\s*(지원|해\s*줘|줘|받)|어떤\s*(지원|혜택)|혜택|깎아|감면|할인|내용/],
  ];
  // 내 조건(판정 결과)이 필요한 질문
  const FIRST_PERSON = /(^|\s)(나|내가|난|나는|나도|저|제가|저는|저도|우리)(\s|$|[,?!])|(^|\s)내\s|(^|\s)제\s/;
  const THIRD_PARTY = /(휴학생|재학생|졸업생|대학원생|학생|사람|직장인|외국인|부모|친구|동생|형|누나|언니|오빠)\s*(도|은|는|이|가)/;
  const CAN_GET = /(받을|신청할|지원할|참여할|들을|될)\s*수\s*(있|없)|해당\s*(돼|되|하)|자격\s*(이|은)?\s*(돼|되|있)|대상\s*(이|인가|이야|인지|일까)/;
  const WHY_NOT = /왜.{0,14}(못|안\s*(돼|되|됨)|미충족|불가|없)|(미충족|안\s*되는|못\s*받는)\s*(이유|까닭)/;
  const WHEN_OK = /언제(부터|쯤|면)?.{0,10}(받을|신청할|자격|충족|가능)/;
  const MOVE_IN = /전입\s*(신고)?\s*(를|을)?\s*(하면|하고\s*나면|한다면|하게\s*되면|했을\s*때)/;
  const NOW_OPEN = /(지금|현재|요즘|당장|오늘).{0,12}(신청|받을|모집|접수).{0,12}(뭐|무엇|어떤|있|알려|목록)|(신청|접수)\s*(가능한|할 수 있는)\s*(거|것|사업|혜택)|모집\s*중인/;
  const WHAT_CAN = /(뭐|뭘|무엇|어떤\s*(거|것|게|사업|혜택|지원)).{0,10}(받을|신청할|지원할)\s*수\s*있|(받을|신청할|지원할)\s*수\s*있는\s*(건|거|것|게|사업|혜택|지원)/;
  const GENERIC_LIST = /(뭐|뭐가|어떤\s*(게|거|것|사업|혜택|지원))\s*(가\s*)?(있|받을|신청할)/;
  const DEADLINE = /마감.{0,8}(임박|얼마\s*안|곧|빨리|가까)|곧\s*마감|얼마\s*안\s*남/;
  const DEFINE = /무슨\s*뜻|뜻(이|은|을)|의미|(이)?란\s*(뭐|무엇)|뭔가요|뭐예요\??$|뭐야\??$|어떻게\s*(계산|세|따져)|계산\s*(법|방법|해)|차이|달라요|다른가요|어떻게\s*해요\??$/;
  const LIST_CUE = /종류|목록|전부|모두|다\s*알려|뭐\s*(가\s*)?있|뭐가\s*있|어떤\s*(게|것|거|사업)|있어요?\??$|있나요?\??$|없나요?\??$|알려\s*줘|알려\s*주세요|추천/;
  const META = /(너|넌|당신|챗봇|ai|에이아이)\s*(는|은|이|가)?\s*(누구|뭐야|뭐니|뭐예요|뭐 ?하는)|뭐\s*(를|을)?\s*(할|물어볼)\s*수\s*있|무엇을\s*(할|물어볼)\s*수|어떤\s*질문|사용법|(어떤|무슨)\s*(모델|ai|인공지능|챗봇)|(뭘|뭐|뭐를|무엇을)\s*물어|(이거|이건|챗봇|도우미|여기)\s*(는|은)?\s*어떻게\s*(써|쓰는|사용)|^(안녕|하이|ㅎㅇ|hello|hi)/;
  const THANKS = /^(고마워|고맙|감사|땡큐|thank|ㄱㅅ|수고했|잘\s*가|바이|bye)/;
  // "~해도 돼요?", "~하면 못 받아요?" 처럼 되는지 묻는 말
  const ASK_OK = /(받을|신청할|지원할|참여할|들을|될)\s*수\s*(있|없)|(못|안)\s*(받|돼|되|해)|가능|되나요|돼요|될까|되는\s*거|(해|어|아|여)도\s*(돼|되)|대상\s*(이|인가|이야|인지|일까)|돼\??$|되나\??$/;
  // 판정 엔진이 보지 않는 조건(학적·취업·소득·가구·주택·병역). 이런 조건을 붙여 물으면 판정 결과가 아니라 공고의 '그 밖의 조건'으로 답한다
  const OTHER_COND = /휴학|재학|졸업|자퇴|편입|대학원|고졸|학생이|취업|취직|직장|회사|재직|퇴사|백수|알바|근로|일하(고|면|는)|프리랜서|사업자|자영업|소득|월급|연봉|재산|수급|차상위|부모|가족|형제|같이\s*살|따로\s*살|동거|결혼|기혼|미혼|신혼|자녀|군대|군인|복무|전역|입대|집이\s*있|자가|주택\s*(소유|이\s*있)|무주택|전세\s*(살|계약)|월세\s*(살|계약)|기숙사|고시원|외국인|국적/;
  // 묶음 질문: 분류 이름이 질문에 직접 나올 때만
  const TAG_WORDS = {
    '장학금': /장학금|장학/, '공모전': /공모전/, '조사원': /조사원|조사요원/, '창업': /창업/, '공공일자리': /공공\s*일자리|공공근로/,
    '주거': /주거|주택\s*지원|집\s*관련/, '저축': /저축|적금|통장/, '자립준비청년': /자립준비|보호종료|보호시설|보육원/,
  };
  // 수집한 항목(대상·내용·기간·방법·문의·참고)에 없는 주제. 해당 사업 청크에 그 낱말이 없으면 "자료에 없다"고 답한다
  const UNCOLLECTED = [
    ['제출 서류', /서류|증빙|구비|첨부|영수증|증명서|통장\s*사본|(뭐|뭘|뭐뭐|무엇을?|어떤\s*(거|것))\s*(를\s*)?(내야|제출|챙겨|준비해야)|준비물/],
    ['선발·심사 방법', /경쟁률|면접|심사|선발\s*(방법|기준)|뽑|합격|커트라인|배점/],
    ['결과 발표·지급 시기', /발표|결과\s*(는|가)?\s*언제|언제\s*(들어|입금|지급|나와)|입금|지급일|얼마나\s*(있다가|걸려|기다려)|며칠\s*(걸려|뒤에)/],
    ['사용처', /어디(서|에)\s*(쓸|사용|써)|사용처|가맹점|쇼핑몰|온라인\s*(쇼핑|결제|사용|에서도)|배달\s*앱|편의점|대형\s*마트/],
    ['중복 수혜', /중복|같이\s*받|동시에/],
    ['세부 근무·이용 조건', /근무\s*(지|장소|시간|요일)|어느\s*(부서|은행|학교|지점)|배치|출퇴근|복장\s*규정|며칠\s*(동안|간)|얼마\s*동안|반납|연체/],
    ['보험·세금', /4대\s*보험|사대\s*보험|고용보험|산재|원천징수|세금\s*(을|은|도)?\s*(떼|내|공제)|퇴직금/],
    ['중도 해지·포기', /해지|중도|중간에\s*(그만|포기|나가|빠지)|그만두|포기하면|환수|돌려줘야/],
    ['받는 중에 사정이 바뀐 경우', /(받는|다니는|참여하는|하는)\s*(중|도중|동안)에?.{0,14}(하면|되면|가면)|계속\s*받을/],
  ];
  // 다른 지역을 콕 집은 질문 (안산·경기도는 범위 안)
  const OTHER_REGION = /(서울|부산|대구|인천|대전|울산|세종|수원|성남|용인|화성|시흥|부천|안양|평택|강원|충북|충남|전북|전남|경북|경남|제주)(특별시|광역시|특별자치시|특별자치도|시|도)?(?=\s|$|의|에서|에|은|는|도|로)|(고양|구리|광주|이천|여주|양주|포천|김포|파주|오산|안성|하남|군포|의왕|광명|과천|남양주|의정부|동두천|가평|양평|연천)(시|군)/;

  const STATUS_LABEL = { eligible: '충족', eligible_if_move_in: '전입하면 충족', eligible_from: '곧 충족', check: '확인필요', ineligible: '미충족' };
  const dot = (d) => (d ? d.replaceAll('-', '.') : '');
  const hasFinal = (w) => { const ch = String(w).replace(/[\s)\]'"」』.]+$/, '').slice(-1); if (ch >= '가' && ch <= '힣') return (ch.charCodeAt(0) - 0xAC00) % 28 !== 0; return '013678lmn'.includes(ch.toLowerCase()); };
  const josa = (w, a, b) => w + (hasFinal(w) ? a : b);
  const shortName = (name) => name.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

  // 사업을 부르는 이름들: 정식 이름에서 연도·기관명·꼬리말을 떼고, 따옴표·괄호 안 이름과 사업별 검색어를 더한다
  function aliasesOf(name, kws) {
    const raw = new Set();
    const inner = [...name.matchAll(/[「『'‘“<]([^」』'’”>]+)[」』'’”>]/g)].map((m) => m[1]);
    const paren = [...name.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(/[·,]/));
    let base = name.replace(/\([^)]*\)/g, ' ').split(/[「『'‘“<]/)[0];
    base = base.replace(/^\s*20\d\d년?\s*(기준\s*)?/, '').replace(/^\s*제\d+기\s*/, '');
    for (const b of [base, base.replace(/^\s*(안산시?|경기도)\s+/, '')]) {
      let x = b.trim(), prev;
      do { raw.add(x); prev = x; x = x.replace(/\s*(구성·운영|구축·운영|구성ㆍ운영|구축ㆍ운영|운영|조성|참여자 모집|지원사업|사업|지원)\s*$/, '').trim(); } while (x !== prev && x.length > 1);
    }
    inner.forEach((x) => raw.add(x)); paren.forEach((x) => raw.add(x));
    raw.add(name);
    const names = [...new Set([...raw].map(compact))];
    // 사업별 검색어는 정식 이름의 일부일 때만 '이름'으로 친다 ('청년인턴'·'기본소득'·'응시료' O, '게임 대회'·'토익' X → 이런 말은 검색 점수로만 반영)
    const frag = (kws || []).map(compact).filter((k) => k.length >= 3 && names.some((n) => n.includes(k)));
    return [...new Set([...names.filter((a) => a.length >= 4), ...frag])];
  }

  // ============================================================
  // 4. 엔진
  // ============================================================
  function create({ corpus, policies, judgePolicy, options = {} }) {
    // minMass·specificIdf·minRatio: 낱말 근거 기준 / denseZ: 의미 검색 1위가 뚜렷하다고 보는 기준 / candZ: 후보로라도 보여 줄 기준
    // denseFloor: 의미 검색 1위 유사도가 이보다 낮으면 관련 없는 질문으로 본다 / oosMargin: 범위 밖 예시가 사업 1위보다 이만큼 더 가까우면 범위 밖
    const opt = { bigram: true, keywords: true, mention: true, scope: true, minMass: 3.5, specificIdf: 2.5, minRatio: 0.5, denseZ: 2.4, candZ: 1.5, denseFloor: 0.45, oosMargin: 0.12, ...options };
    const P = new Map(policies.map((p) => [p.id, p]));
    const meta = corpus.policyMeta || {};
    const chunks = corpus.chunks;
    const byId = new Map(chunks.map((c) => [c.id, c]));
    // 검색 단위: 사업 1건 / 도움말 1개 / 범위 밖 유형 1개 (청크 여러 개가 한 단위로 묶인다)
    const unitOf = (c) => c.unit || c.policyId || c.id;
    const chunksOf = new Map();
    chunks.forEach((c) => { const k = unitOf(c); if (!chunksOf.has(k)) chunksOf.set(k, []); chunksOf.get(k).push(c); });
    const unitType = (key) => (P.has(key) ? 'policy' : (chunksOf.get(key)?.[0]?.section === 'oos' ? 'oos' : 'help'));
    const chunkNo = new Map(chunks.map((c, i) => [c.id, i]));
    const titleOf = (c) => (c.policyId ? P.get(c.policyId).name : c.title);

    const index = buildIndex(chunks.map((c) => ({
      id: c.id, oos: c.section === 'oos',
      fields: {
        title: titleOf(c),
        body: c.text.split('\n').slice(1).join('\n'),
        kw: opt.keywords ? (c.policyId ? [...(meta[c.policyId]?.kw || []), ...(meta[c.policyId]?.tags || [])] : (c.keywords || [])).join(' ') : '',
      },
    })), { bigram: opt.bigram, fieldWeights: options.fieldWeights });

    // 단위별 '이름·검색어' 낱말 (본문에만 나오는 낱말과 구분한다)
    const anchorCache = new Map();
    function anchorOf(key) {
      if (!anchorCache.has(key)) {
        const cs = chunksOf.get(key) || [], c0 = cs[0];
        const kw = !c0 ? [] : (c0.policyId ? [...(meta[c0.policyId]?.kw || []), ...(meta[c0.policyId]?.tags || [])] : cs.flatMap((c) => c.keywords || []));
        anchorCache.set(key, new Set(c0 ? wordTokens([titleOf(c0), ...kw].join(' ')) : []));
      }
      return anchorCache.get(key);
    }

    // 한 사업만 가리키는 이름 (여러 사업이 같이 쓰는 말은 묶음 질문·검색 점수로만 쓴다)
    const aliasOwner = new Map();
    for (const p of policies) for (const a of aliasesOf(p.name, opt.keywords ? meta[p.id]?.kw : [])) {
      if (!aliasOwner.has(a)) aliasOwner.set(a, new Set()); aliasOwner.get(a).add(p.id);
    }
    const kwOwner = new Map();                 // 검색어 → 그 검색어를 쓰는 사업들 (다른 사업도 쓰는 말은 한 사업의 이름으로 치지 않는다: '조사원')
    for (const p of policies) for (const k of (opt.keywords ? meta[p.id]?.kw || [] : []).map(compact)) { if (!kwOwner.has(k)) kwOwner.set(k, new Set()); kwOwner.get(k).add(p.id); }
    const uniqueAliases = [...aliasOwner].filter(([a, s]) => s.size === 1 && (kwOwner.get(a)?.size || 1) === 1).map(([a, s]) => [a, [...s][0]]).sort((x, y) => y[0].length - x[0].length);
    // 질문에서 사업 이름을 지운 나머지 (의도를 읽을 때 '청년기본소득'의 '소득' 같은 글자에 속지 않게)
    function withoutNames(query, pids) {
      let t = rewrite(query);
      for (const pid of pids) for (const [a, owner] of uniqueAliases) {
        if (owner !== pid) continue;
        t = t.replace(new RegExp([...a].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9가-힣]*')), ' ');
      }
      return t;
    }

    function mentions(query) {
      if (!opt.mention) return [];
      const q = compact(rewrite(query)), taken = [], found = [];
      for (const [a, pid] of uniqueAliases) {
        const at = q.indexOf(a); if (at < 0) continue;
        if (taken.some(([s, e]) => at < e && at + a.length > s)) continue;      // 더 긴 이름이 이미 차지한 자리
        taken.push([at, at + a.length, pid]);
      }
      taken.sort((x, y) => x[0] - y[0]);                                          // 질문에 나온 순서대로
      for (const [, , pid] of taken) if (!found.includes(pid)) found.push(pid);
      return found;
    }

    // ---- 검색: 청크 점수 → 단위(사업·도움말·범위 밖 유형) 순위 ----
    function rankUnits(scores, isDense) {
      const groups = new Map();
      for (let i = 0; i < chunks.length; i++) {
        const sc = scores[i];
        if (!isDense && sc <= 0) continue;
        const key = unitOf(chunks[i]);
        let g = groups.get(key); if (!g) groups.set(key, (g = []));
        g.push({ chunk: chunks[i], score: sc });
      }
      return [...groups].map(([key, list]) => {
        list.sort((a, b) => b.score - a.score);
        return { key, type: unitType(key), score: isDense ? list[0].score : list[0].score + 0.3 * (list[1]?.score || 0), chunks: list };
      }).sort((a, b) => b.score - a.score);
    }
    // dense(청크별 코사인 유사도 배열)가 오면 의미 검색 순위를 쓰고, 없으면 BM25 순위를 쓴다. 이름이 나온 사업은 어느 쪽이든 맨 앞.
    // ranked·all 은 사업·도움말만 담는다. 범위 밖 예시가 1위였는지는 scope 에 따로 담는다
    function search(query, k = 5, dense = null) {
      const lexAll = rankUnits(scoreAll(index, query), false);
      const denAll = dense ? rankUnits(dense, true) : null;
      const inScope = (r) => r.type !== 'oos';
      const lex = lexAll.filter(inScope), den = denAll ? denAll.filter(inScope) : null;
      const ranked = (den || lex).slice();
      // 의미 검색일 때: 1위가 전체 분포에서 얼마나 튀는지(z). 범위 밖 질문은 어느 문서와도 비슷하게 낮아서 z 가 작다
      let z = null;
      if (den && ranked.length > 2) {
        const v = ranked.map((r) => r.score), mean = v.reduce((a, b) => a + b, 0) / v.length;
        const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) || 1;
        z = (v[0] - mean) / sd;
      }
      const natural = ranked[0] || null, naturalScore = natural ? natural.score : 0;
      // 범위 밖인지: 낱말 쪽은 유형별 낱말·이름이 질문에 있을 때, 의미 쪽은 범위 밖 예시가 사업 1위보다 가까울 때(차이는 margin)
      const denTop = denAll ? denAll[0] : null;
      const scope = !opt.scope ? { lex: null, den: null } : {
        lex: scopeLex(query),
        den: denTop && denTop.type === 'oos' ? { key: denTop.key, score: denTop.score, margin: denTop.score - naturalScore } : null,
      };
      const lexEv = evidence(query, lex[0] || null);
      const m = mentions(query);
      if (m.length) {
        const top = naturalScore || 1;
        for (const pid of m) {
          let r = ranked.find((x) => x.key === pid);
          if (!r) ranked.push((r = { key: pid, type: 'policy', score: 0, chunks: [] }));
          else ranked[ranked.indexOf(r)] = (r = { ...r });
          r.score += top + 1 + (m.length - m.indexOf(pid)) * 1e-6; r.mentioned = true;      // 질문에 먼저 나온 사업이 앞에 오게
        }
        ranked.sort((a, b) => b.score - a.score);
      }
      return { ranked: ranked.slice(0, k), all: ranked, mentioned: m, evidence: den ? evidence(query, natural) : lexEv, lexEvidence: lexEv, lexTop: lex[0] || null, z, dense: !!dense, scope, natural };
    }

    const NAME_TAIL_WORD = /^(적금|통장|계좌|저축|장학금|수당|급여|연금|지원금|장려금|바우처|이용권|카드|패스|대출|보험|공제|주택|임대|청약|제도)$/;
    // 수집한 자료(사업·도움말)에 없는 낱말인지: 4글자 이상 한글 낱말이고, 자료에 있는 낱말들로 쪼개지지도 않을 때
    //  '월세지원금' = 월세+지원금 → 있는 말 / '청년희망적금' = 청년+희망(없음)+적금 → 없는 말(이름일 수 있다)
    const known = (w) => (index.dfIn.get(w) || 0) > 0 || NAME_TAIL_WORD.test(w);
    function splits(w) {
      if (known(w)) return true;
      for (let i = 2; i <= w.length - 2; i++) if (known(w.slice(0, i)) && splits(w.slice(i))) return true;
      return false;
    }
    const isUnseen = (w) => /^[가-힣]{4,}$/.test(w) && !splits(w);
    // 제도 이름처럼 생긴 낱말: 자료에 없는 말이면서 제도 종류를 나타내는 말로 끝난다 ('행복주택', '청년희망적금', '국가장학금')
    const NAME_TAIL = /(적금|통장|계좌|저축|장학금|수당|급여|연금|지원금|장려금|바우처|이용권|카드|패스|대출|보험|공제|주택|임대|청약|제도)$/;
    const unknownNames = (query) => [...new Set(wordTokens(query))].filter((w) => isUnseen(w) && NAME_TAIL.test(w));

    // 범위 밖 유형별 낱말(머리 청크의 keywords)과 자료에 없는 제도 이름(names).
    // 낱말 검색 쪽 판단은 이 낱말이 질문에 '그대로' 있을 때만 한다 (예시 문장에 우연히 들어간 '제도'·'영어' 같은 말로는 판단하지 않는다)
    const scopeUnits = chunks.filter((c) => c.section === 'oos' && c.id === unitOf(c)).map((h) => ({
      key: h.id, kws: (h.keywords || []).filter((k) => !(h.names || []).includes(k)).map((k) => wordTokens(k)).filter((t) => t.length),
      names: (h.names || []).map((n) => [n, compact(n)]).filter(([, c]) => c.length >= 3),
    }));
    function scopeLex(query) {
      const qt = new Set(wordTokens(query)), cq = compact(rewrite(query));
      let best = null;
      for (const u of scopeUnits) {
        const name = u.names.find(([, c]) => cq.includes(c));
        const hits = u.kws.filter((t) => t.every((w) => qt.has(w)));          // 낱말 여러 개짜리('영화 추천')는 모두 있어야 한다
        const n = hits.length + (name ? 2 : 0);
        if (n && (!best || n > best.n)) best = { key: u.key, n, name: name ? name[0] : null, words: hits.map((t) => t.join(' ')) };
      }
      return best;
    }

    // 어느 사업 이야기에나 나올 수 있는 말. 자료가 짧아서 드물게 나오지만(idf 가 높지만) 그 사업을 가리키는 근거로는 치지 않는다
    const GENERIC = new Set(['지원금', '지원', '혜택', '사업', '제도', '프로그램', '서비스', '정보', '추천', '방법', '신청', '접수', '모집', '참여', '활동', '운영', '대상', '기간', '내용', '문의', '안산', '안산시', '안산시청', '시청', '청년']);
    // 검색 1위가 믿을 만한지: 질문의 낱말 중 그 단위의 청크에 '그대로' 있는 낱말의 idf 합(mass)과 비율(ratio).
    // 글자 2-gram만 겹친 경우는 세지 않는다 → '국민취업지원제도'처럼 자료에 없는 이름을 비슷한 사업으로 답하지 않게
    function evidence(query, top) {
      const words = [...new Set(wordTokens(query))].filter((w) => w.length >= 2 || /[a-z0-9]/.test(w));
      if (!words.length || !top) return { mass: 0, ratio: 0, specific: 0, anchor: 0, matched: [], unseen: [] };
      const idx = (chunksOf.get(top.key) || []).map((c) => chunkNo.get(c.id));
      const unseenIdf = Math.log(1 + (index.inN + 0.5) / 0.5);
      const w8 = (w) => index.idf.get(w) ?? unseenIdf;
      const matched = words.filter((w) => { const m = index.postings.get(w); return m && idx.some((i) => m.has(i)); });
      const mass = matched.reduce((a, w) => a + w8(w), 0);
      const anchors = anchorOf(top.key);
      // 자료 어디에도 없는 긴 낱말 (이름일 수 있다: '청년희망적금'). 의미 검색이 비슷한 사업을 '그 사업'인 것처럼 답하지 않게 하는 데 쓴다
      const unseen = words.filter(isUnseen);
      const spec = matched.filter((w) => w8(w) >= opt.specificIdf && !GENERIC.has(w));
      return { mass, ratio: mass / words.reduce((a, w) => a + w8(w), 0), specific: spec.length, anchor: spec.filter((w) => anchors.has(w)).length, matched, unseen };
    }
    // hasEvidence: 드문 낱말이 하나라도 그대로 겹친다(그 사업 이야기일 수 있다)
    // confident: 바로 답해도 될 만큼 겹친다 — 드문 낱말 2개 이상, 또는 질문 대부분이 겹치고 그 낱말이 그 사업의 이름·검색어에 있다('월세', '토익')
    //  드문 낱말 하나('지원금', '혼자')만 겹친 경우는 1위가 틀리는 일이 잦아서(2차 분석) 바로 답하지 않고 후보로 보여 준다
    const hasEvidence = (ev) => ev.specific >= 1 && ev.mass >= opt.minMass;
    const confident = (ev) => hasEvidence(ev) && (ev.specific >= 2 || (ev.ratio >= opt.minRatio && ev.anchor >= 1));

    function sectionOf(query) {
      for (const [sec, re] of SECTION_RULES) if (re.test(query)) return sec;
      return null;
    }

    function judge(pid, ctx) { return ctx.profile ? judgePolicy(P.get(pid), ctx.profile, ctx.today) : null; }
    function recruitLine(r) {
      const rc = r.recruit;
      if (rc.state === 'open') return `지금 접수 중이고 마감까지 ${josa('D-' + rc.dday, '이에요', '예요')}.`;
      if (rc.state === 'upcoming') return `접수 시작까지 ${josa('D-' + rc.dday, '이에요', '예요')}.`;
      if (rc.state === 'always') return '상시 신청할 수 있어요.';
      if (rc.state === 'closed') return '이번 모집은 마감됐어요.';
      return '모집 일정은 공고에서 확인해야 해요.';
    }
    function verdictLine(r, me = '내 조건') {
      const why = r.checks.filter((c) => c.state !== 'ok').map((c) => c.text);
      if (r.status === 'eligible') return `${me}으로는 거주·나이 조건을 모두 채웠어요(충족).`;
      if (r.status === 'eligible_if_move_in') return `${me}으로는 안산 주민등록만 없어요. 전입신고하면 충족이에요.`;
      if (r.status === 'eligible_from') return `${me}으로는 아직 모자라고, ${dot(r.eligibleFrom)}부터 충족이에요. (${why.join(' / ')})`;
      if (r.status === 'check') return `${me}만으로는 판정하지 못했어요(확인필요). ${r.hint || ''}`.trim();
      return `${me}으로는 미충족이에요. ${r.hint || ''} (${why.join(' / ')})`.replace(/\s+\(\)$/, '');
    }
    // 판정 결과를 모델에게 줄 '자료' 한 덩어리로
    function judgeFact(pid, r) {
      const lines = [`판정: ${STATUS_LABEL[r.status]}${r.eligibleFrom ? ` (${r.eligibleFrom}부터 충족)` : ''}`];
      r.checks.forEach((c) => lines.push(`${c.key === 'age' ? '나이' : '거주'}: ${c.text}`));
      if (r.hint) lines.push(`안내: ${r.hint}`);
      if (r.selfCheck?.length) lines.push(`직접 확인할 조건(판정 안 함): ${r.selfCheck.join(' / ')}`);
      lines.push(`모집 상태: ${recruitLine(r)}`);
      return `${P.get(pid).name} | 내 조건 판정 결과\n` + lines.map((l) => `- ${l}`).join('\n');
    }

    const src = (c) => ({
      chunkId: c.id, policyId: c.policyId, section: c.section, label: `${titleOf(c)} · ${SECTION_LABEL[c.section]}`,
      quote: c.quote || null, url: c.policyId ? P.get(c.policyId).sourceUrl : (c.sourceUrl || null),
      sourceLabel: c.policyId ? (meta[c.policyId]?.sourceLabel || '안산시청') : (c.sourceUrl ? '외부 자료' : '서비스 도움말'),
    });
    const getChunk = (pid, sec) => byId.get(`${pid}#${sec}`);
    // 나이 조건을 글로: 만 19~34세 / 만 29세 이하 / 만 19세 이상 / 제한 없음
    function ageText(p) {
      const { min, max } = p.age || {};
      if (min == null && max == null) return null;
      if (min != null && max != null) return min === max ? `만 ${min}세` : `만 ${min}~${max}세`;
      return min != null ? `만 ${min}세 이상` : `만 ${max}세 이하`;
    }
    const ageFits = (p, n) => (p.age?.min == null || n >= p.age.min) && (p.age?.max == null || n <= p.age.max);
    // 개요 문장에서 "○○은 △△ 분야 사업이에요." 를 뗀 나머지 (여러 사업을 나란히 보여 줄 때)
    const gist = (pid) => { const o = getChunk(pid, 'overview'); return o ? o.say.replace(/^[^.]*분야 사업이에요\.\s*/, '').trim() : P.get(pid).benefit; };
    // 질문 낱말과 가장 많이 겹치는 줄 (사업명 낱말은 빼고 센다) → 답 맨 앞에 보여 준다
    function bestLine(query, chunk) {
      const nameTok = new Set(tokenize(titleOf(chunk), false));
      const q = tokenize(query).filter((t) => !nameTok.has(t));
      let best = null, bestScore = 0;
      for (const line of chunk.text.split('\n').slice(1)) {
        const lt = new Set(tokenize(line));
        const s = q.reduce((a, t) => a + (lt.has(t) ? (t[0] === '§' ? 0.5 : 1.5) : 0), 0);
        if (s > bestScore) { best = line.replace(/^- /, ''); bestScore = s; }
      }
      return bestScore >= 1.5 ? best : null;
    }

    const SYSTEM = [
      "당신은 '안산 청년 혜택 알리미'의 공고문 안내 도우미입니다. 아래 규칙을 지켜 한국어 존댓말(해요체)로 답하세요.",
      '1. [자료]에 적힌 내용만 사용합니다. 자료에 없는 내용은 지어내지 말고 "수집한 공고 자료에는 그 내용이 없어요. 원문에서 확인해 주세요."라고 답합니다.',
      '2. 자격을 직접 판정하지 않습니다. [자료]에 "내 조건 판정 결과"가 있으면 그 결과를 그대로 전하고 이유를 설명합니다.',
      '3. 금액·날짜·나이·전화번호는 자료에 적힌 숫자 그대로 씁니다.',
      '4. 질문에 대한 답부터 말하고, 2~3문장으로 짧게 씁니다. 문장 끝에 근거 번호를 [1]처럼 붙입니다.',
    ].join('\n');
    function prompt(query, contexts) {
      const body = contexts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n');
      return { system: SYSTEM, user: `[자료]\n${body}\n\n[질문] ${query}\n\n[답]` };
    }

    const SUGGEST_HOME = ['전입신고하면 뭐가 달라져요?', '지금 신청할 수 있는 거 뭐 있어?', '거주 기간은 어떻게 계산해요?'];
    const suggestFor = () => ['나는 받을 수 있어?', '얼마 받아요?', '어디서 신청해요?', '언제 모집해요?'];
    const SCOPE_LINE = `저는 안산시청에 올라온 청년 사업 ${policies.length}건의 공고 내용만 답할 수 있어요.`;

    // ---- 답 만들기 ----
    function answer(query, ctx = {}) {
      const q = String(query || '').trim();
      const page = ctx.page && P.has(ctx.page) ? ctx.page : null;
      const prev = ctx.prev && P.has(ctx.prev) ? ctx.prev : null;      // 바로 앞 답에서 다룬 사업 (이어 묻는 질문용)
      const base = { query: q, kind: 'abstain', intent: null, section: null, focus: null, text: '', policies: [], sources: [], cards: [], abstain: false, reason: null, llm: { use: false }, suggestions: SUGGEST_HOME, debug: {} };
      const done = (route, o) => ({ ...base, ...o, debug: { ...base.debug, route } });
      if (!q) return done('empty', { abstain: true, reason: 'empty', text: '질문을 입력해 주세요.' });

      // (1) 인사·챗봇 소개
      if (THANKS.test(norm(q)) && q.length < 20) {
        return done('인사', { kind: 'meta', intent: 'meta', text: '도움이 됐다면 다행이에요. 더 궁금한 사업이 있으면 언제든 물어보세요.' });
      }
      if (META.test(norm(q)) && q.length < 30) {
        return done('챗봇 소개', { kind: 'meta', intent: 'meta', text: `안산시 청년 사업 ${policies.length}건의 공고 내용을 근거로 답하는 도우미예요. 지원 금액·대상·기간·신청 방법·문의처를 물어보거나, "나는 받을 수 있어?", "전입신고하면 뭐가 달라져요?"처럼 내 조건으로 물어볼 수 있어요. 자격 판정은 결과 화면의 규칙 엔진이 하고, 저는 그 결과와 공고 내용을 설명해요.` });
      }
      // (2) 다른 지역
      const region = q.match(OTHER_REGION);
      if (region && !/안산/.test(q)) {
        return done('다른 지역', { abstain: true, reason: 'other_region', intent: 'oos', text: `${region[0]} 사업은 다루지 않아요. 이 서비스는 안산시청에 올라온 청년 사업 ${policies.length}건만 다뤄요. 전국 사업은 온통청년(youthcenter.go.kr)에서 찾아볼 수 있어요.` });
      }

      const found = search(q, 6, ctx.dense || null);
      const mentioned = found.mentioned;
      const bare = withoutNames(q, mentioned);                    // 사업 이름을 뺀 질문 (의도 읽기용)
      const section = sectionOf(bare);
      const firstPerson = FIRST_PERSON.test(q), third = THIRD_PARTY.test(bare);
      const ev = found.evidence;
      const saidAge = (() => { const m = bare.match(/(?:만\s*)?(\d{1,2})\s*세(?!대)/); return m && ASK_OK.test(bare) ? Number(m[1]) : null; })();
      base.debug = { mode: found.dense ? 'dense' : 'bm25', z: found.z == null ? null : +found.z.toFixed(2), mass: +ev.mass.toFixed(1), specific: ev.specific, matched: ev.matched, unseen: ev.unseen,
        top: found.ranked.slice(0, 3).map((r) => [r.key, +r.score.toFixed(2)]), lexTop: found.lexTop ? found.lexTop.key : null, mentioned, section,
        scope: { lex: found.scope.lex ? [found.scope.lex.key, found.scope.lex.name || found.scope.lex.words.join('·')] : null, den: found.scope.den ? [found.scope.den.key, +found.scope.den.score.toFixed(2), +found.scope.den.margin.toFixed(2)] : null } };

      const tag = Object.keys(TAG_WORDS).find((t) => TAG_WORDS[t].test(q));
      const tagIds = tag ? policies.filter((p) => (meta[p.id]?.tags || []).includes(tag)).map((p) => p.id) : [];
      // 내 조건으로 지금 신청할 수 있는 사업 목록 ("지금 신청할 수 있는 거?", "뭐 받을 수 있어?", "지원금 뭐 있어?")
      const openList = (route) => {
        const res = policies.map((p) => judgePolicy(p, ctx.profile, ctx.today)).filter((r) => r.status === 'eligible');
        const open = res.filter((r) => r.recruit.state === 'open').sort((a, b) => a.recruit.dday - b.recruit.dday);
        const always = res.filter((r) => r.recruit.state === 'always');
        const nm = (r) => shortName(r.name);
        return done(route, { kind: 'judge', intent: 'now_open', policies: [...open, ...always].map((r) => r.id), cards: [...open, ...always].slice(0, 6).map((r) => r.id),
          text: `내 조건으로 지금 신청할 수 있는 사업은 접수 중 ${open.length}건, 상시 ${always.length}건이에요.` +
            (open.length ? ` 접수 중: ${open.map((r) => `${nm(r)}(D-${r.recruit.dday})`).join(', ')}.` : '') +
            (always.length ? ` 상시: ${always.slice(0, 4).map(nm).join(', ')}${always.length > 4 ? ' 등' : ''}.` : '') +
            ' 소득·취업·학적 조건은 각 사업 화면에서 직접 확인해 주세요.' });
      };
      // (3) 내 조건으로 훑어보는 질문 (판정 엔진 결과만으로 답한다)
      if (ctx.profile && !mentioned.length) {
        const all = () => policies.map((p) => judgePolicy(p, ctx.profile, ctx.today));
        const openNow = (r) => ['open', 'always'].includes(r.recruit.state);
        const nm = (r) => shortName(r.name);
        if (MOVE_IN.test(q) && /(뭐|무엇|어떤|달라|바뀌|더\s*받|좋|혜택)/.test(q)) {
          const res = all();
          if (ctx.profile.ansanRegistered) {
            const need = res.filter((r) => r.checks[0].state === 'ok' && P.get(r.id).residence.type !== 'R7' && P.get(r.id).residence.type !== 'R10');
            return done('판정 엔진(전입 효과)', { kind: 'judge', intent: 'move_in', policies: need.slice(0, 6).map((r) => r.id), cards: need.slice(0, 6).map((r) => r.id),
              text: `이미 안산으로 전입신고가 되어 있어요. 안산·경기도 주민등록이 필요한 사업 ${need.length}건은 거주 조건을 채운 상태예요. 거주 '기간'이 필요한 사업은 전입일부터 계산해요.` });
          }
          const mv = res.filter((r) => r.status === 'eligible_if_move_in');
          const open = mv.filter(openNow);
          const order = [...open, ...mv.filter((r) => !openNow(r))];
          return done('판정 엔진(전입 효과)', { kind: 'judge', intent: 'move_in', policies: order.map((r) => r.id), cards: order.slice(0, 6).map((r) => r.id),
            text: `전입신고하면 ${mv.length}건이 '충족'으로 바뀌어요. 그중 지금 신청할 수 있는 건 ${open.length}건이에요${open.length ? `: ${open.slice(0, 4).map(nm).join(', ')}` : ''}. 거주 '기간'이 필요한 사업(장학금 등)은 전입한 날부터 기간을 세기 시작해요.`,
            sources: [src(byId.get('HELP_MOVEIN'))] });
        }
        if (DEADLINE.test(q)) {
          const res = all().filter((r) => r.recruit.state === 'open' && r.status !== 'ineligible').sort((a, b) => a.recruit.dday - b.recruit.dday);
          const ok = res.filter((r) => r.status === 'eligible');
          const first = ok[0] || res[0];
          if (!first) return done('판정 엔진(마감 임박)', { kind: 'judge', intent: 'deadline', text: '지금 접수 중인 사업이 없어요.' });
          return done('판정 엔진(마감 임박)', { kind: 'judge', intent: 'deadline', policies: res.map((r) => r.id), cards: res.slice(0, 6).map((r) => r.id),
            text: `지금 접수 중인 사업은 ${res.length}건이에요. 내 조건으로 바로 신청할 수 있는 것 중 마감이 가장 가까운 건 ${nm(first)}(D-${first.recruit.dday})예요.` +
              (res[0] !== first ? ` ${nm(res[0])}(D-${res[0].recruit.dday})는 더 빨리 마감하지만 지금은 '${STATUS_LABEL[res[0].status]}' 상태예요.` : '') });
        }
        const whatCan = WHAT_CAN.test(q) && !third && !tag;
        if (whatCan && saidAge != null) {
          const fit = all().filter((r) => ageFits(P.get(r.id), saidAge));
          const open = [...fit.filter((r) => r.recruit.state === 'open').sort((a, b) => a.recruit.dday - b.recruit.dday), ...fit.filter((r) => r.recruit.state === 'always')];
          return done('나이로 훑어보기', { kind: 'judge', intent: 'age_list', policies: open.map((r) => r.id), cards: open.slice(0, 6).map((r) => r.id),
            text: `만 ${saidAge}세가 나이 조건에 드는 사업은 ${policies.length}건 중 ${fit.length}건이에요. 그중 지금 신청할 수 있는 건 ${open.length}건이에요${open.length ? `: ${open.slice(0, 5).map(nm).join(', ')}${open.length > 5 ? ' 등' : ''}` : ''}. 말한 나이만 본 결과예요. 거주 조건까지 보려면 '내 조건'에 생년월일과 전입일을 넣어 주세요.` });
        }
        if ((NOW_OPEN.test(q) || whatCan) && !third) return openList('판정 엔진(지금 신청 가능)');
      }

      // (3-1) 다루지 않는 범위: 범위 밖 낱말·이름이 질문에 있거나(낱말), 범위 밖 예시가 사업보다 뚜렷이 가까울 때(의미)
      //       사업 이름을 말한 질문은 제외. 분류 이름('장학금')이 나온 질문은 자료에 없는 제도 이름('국가장학금')을 콕 집었을 때만
      const nearPolicies = () => found.all.filter((r) => r.type === 'policy').slice(0, 3).map((r) => r.key);
      if (!mentioned.length) {
        const sl = found.scope.lex, sd = found.scope.den && found.scope.den.margin >= opt.oosMargin ? found.scope.den : null;
        const hit = sl && (sl.name || !tag) ? sl : (!tag && sd ? sd : null);
        if (hit) {
          const head = byId.get(hit.key), nm = hit.name || null;
          const cards = head.near ? (tagIds.length ? tagIds.slice(0, 6) : nearPolicies()) : [];
          const text = (nm ? `'${nm}'${hasFinal(nm) ? '은' : '는'} ` : (head.names?.length ? '물어보신 제도는 ' : '')) + head.say + ' ' + SCOPE_LINE
            + (cards.length ? (tagIds.length ? ` 안산시청에 올라온 '${tag}' 사업은 아래와 같아요.` : ' 안산시 사업 중 가까운 것은 아래와 같아요.') : '');
          return done(`범위 밖(${hit === sl ? '낱말: ' + (nm || sl.words.join('·')) : '의미 검색'}) → ${head.title}`, { abstain: true, reason: 'out_of_scope', intent: 'oos', text, policies: cards, cards });
        }
        // 자료에 없는 제도 이름처럼 생긴 낱말('청년희망적금', '행복주택') → 비슷한 사업을 그 제도인 것처럼 답하지 않는다
        const unk = unknownNames(q);
        if (unk.length) {
          const cards = tagIds.length ? tagIds.slice(0, 6) : nearPolicies();
          return done(`자료에 없는 이름: ${unk[0]}`, { abstain: true, reason: 'unknown_name', intent: 'oos', policies: cards, cards,
            text: `'${unk[0]}'${hasFinal(unk[0]) ? '은' : '는'} 수집한 안산시 청년 사업 ${policies.length}건에 없는 이름이에요. 전국 단위 제도는 온통청년(youthcenter.go.kr)에서 찾아볼 수 있어요.`
              + (cards.length ? (tagIds.length ? ` 안산시청에 올라온 '${tag}' 사업은 아래와 같아요.` : ' 안산시 사업 중 가까운 것은 아래와 같아요.') : '') });
        }
      }

      // (3-2) 두 사업을 함께 말한 질문 → 나란히 보여 준다
      if (mentioned.length >= 2) {
        const ids = mentioned.slice(0, 3);
        const nameOf = (id) => shortName(P.get(id).name);
        const mark = (i) => '①②③'[i];
        const askMe = ctx.profile && !third && !saidAge && (WHY_NOT.test(bare) || WHEN_OK.test(bare) || (CAN_GET.test(bare) && (firstPerson || !section)));
        if (askMe) {
          const rs = ids.map((id) => judge(id, ctx));
          let text = ids.map((id, i) => `${mark(i)} ${nameOf(id)}: ${verdictLine(rs[i])}${['eligible', 'eligible_if_move_in'].includes(rs[i].status) ? ' ' + recruitLine(rs[i]) : ''}`).join(' ');
          if (/둘\s*다|같이|동시에|함께|중복/.test(bare)) text += ' 두 사업을 함께 받을 수 있는지(중복 여부)는 수집한 자료에 없어요. 공고 원문이나 담당부서에 확인해 주세요.';
          return done('비교(판정 엔진)', { kind: 'compare', intent: 'compare_judge', section: 'target', policies: ids, cards: ids, text,
            sources: ids.map((id) => src(getChunk(id, 'target'))), suggestions: [`${nameOf(ids[0])} 얼마 받아요?`, `${nameOf(ids[1])} 얼마 받아요?`],
            llm: { use: true, ...prompt(q, ids.flatMap((id, i) => [judgeFact(id, rs[i])])) } });
        }
        const sec = section && ids.every((id) => getChunk(id, section)) ? section : null;
        const parts = ids.map((id) => (sec ? getChunk(id, sec).say.trim() : gist(id)));
        let text = ids.map((id, i) => `${mark(i)} ${nameOf(id)}: ${parts[i]}`).join(' ');
        if (sec === 'benefit') text += ' 금액을 세는 기준(월·분기·총액)이 사업마다 달라서 나란히 보여 드려요.';
        const cs = ids.map((id) => getChunk(id, sec || 'overview'));
        return done('비교', { kind: 'compare', intent: 'compare', section: sec, policies: ids, cards: ids, text, sources: cs.map(src),
          suggestions: [`${nameOf(ids[0])} 나는 받을 수 있어?`, `${nameOf(ids[1])} 나는 받을 수 있어?`],
          llm: { use: true, ...prompt(q, sec ? cs.map((c) => c.text) : ids.flatMap((id) => [getChunk(id, 'benefit'), getChunk(id, 'target')].filter(Boolean).map((c) => c.text))) } });
      }

      // (4) 묶음 질문 (장학금·공모전처럼 분류 이름이 나온 경우)
      if (tag && !mentioned.length && !(page && /이거|이건|여기|이 사업/.test(q))) {
        const ids = tagIds.slice();
        const scoreOf = new Map(found.all.map((r) => [r.key, r.score]));
        ids.sort((a, b) => (scoreOf.get(b) || 0) - (scoreOf.get(a) || 0));
        if (ids.length) {
          let text = `'${tag}' 사업은 ${ids.length}건이에요: ${ids.map((id) => shortName(P.get(id).name)).join(', ')}.`;
          // 묻는 항목이 있으면("장학금 신청 기간") 사업마다 그 항목 한 줄을 붙인다. 내 조건·나이를 물은 경우는 판정 요약이 먼저
          const LINE = { period: ['접수 기간', '안내'], benefit: ['금액', '내용'], method: ['신청 방법'], contact: ['담당', '문의'], target: ['나이', '거주'] }[section];
          const lineOf = (id) => { const c = getChunk(id, section); if (!c || c.thin) return null; for (const lb of LINE) { const m = c.text.match(new RegExp(`\\n- ${lb}: ([^\\n]+)`)); if (m) return m[1]; } return null; };
          let listSection = null;
          if (saidAge != null) {
            const fit = ids.filter((id) => ageFits(P.get(id), saidAge));
            text += ` 그중 만 ${saidAge}세가 나이 조건에 드는 사업은 ${fit.length}건이에요${fit.length ? `: ${fit.map((id) => shortName(P.get(id).name)).join(', ')}` : ''}. (말한 나이를 만 나이로 봤어요)`;
          } else if (ctx.profile && (WHEN_OK.test(q) || CAN_GET.test(q) || firstPerson)) {
            const rs = ids.map((id) => judge(id, ctx));
            const by = (s) => rs.filter((r) => r.status === s);
            const parts = [];
            if (by('eligible').length) parts.push(`충족 ${by('eligible').length}건`);
            if (by('eligible_if_move_in').length) parts.push(`전입하면 충족 ${by('eligible_if_move_in').length}건`);
            const from = by('eligible_from');
            if (from.length) parts.push(`곧 충족 ${from.length}건(${[...new Set(from.map((r) => dot(r.eligibleFrom)))].join(', ')}부터)`);
            if (by('ineligible').length) parts.push(`미충족 ${by('ineligible').length}건`);
            text += ` 내 조건으로는 ${parts.join(', ')}이에요.`;
          } else if (LINE && ids.length <= 8) {
            listSection = section;
            text = `'${tag}' 사업 ${ids.length}건의 ${SECTION_LABEL[section]}${hasFinal(SECTION_LABEL[section]) ? '이에요' : '예요'}: ` + ids.map((id, i) => `${'①②③④⑤⑥⑦⑧'[i]} ${shortName(P.get(id).name)} — ${lineOf(id) || '자료에 없음'}`).join(' ') + '.';
          }
          return done(`분류 묶음: ${tag}`, { kind: 'list', intent: 'list', section: listSection, policies: ids, cards: ids.slice(0, 8), text,
            sources: ids.slice(0, 3).map((id) => src(getChunk(id, 'overview'))),
            llm: { use: false } });
        }
      }

      // (5) 어느 사업 이야기인지 정하기: 이름이 나온 사업 > 화면에서 보고 있는 사업 > 검색 1위
      let target = null, how = null;
      const top = found.ranked[0];
      const topIsHelp = top && top.type === 'help';
      const define = DEFINE.test(bare);
      // 뜻·계산법을 묻는 질문이면 도움말을 먼저 본다 (점수가 1위의 60% 이상일 때)
      const near = (x) => (found.dense ? x.score >= top.score - 0.05 : x.score >= 0.6 * top.score);
      const helpHit = top && found.ranked.slice(0, 3).find((x) => x.type === 'help' && near(x));
      // 상세 화면에서 물으면 그 사업에 대한 질문으로 본다 (다른 사업 이름을 말했거나 용어 뜻을 묻는 경우는 예외).
      // 단, 그 사업과 이어지는 단서가 하나는 있어야 한다: 묻는 항목·내 조건 표현·'이거'·수집 안 한 주제·겹치는 낱말·검색 1위
      const cue = section || CAN_GET.test(bare) || WHY_NOT.test(bare) || WHEN_OK.test(bare) || saidAge != null || (OTHER_COND.test(bare) && ASK_OK.test(bare)) || UNCOLLECTED.some(([, re]) => re.test(bare));
      // 두 경우 모두, 질문의 낱말이 다른 사업을 가리키면(낱말 근거) 그 사업을 찾는 질문으로 본다
      const lexOther = (cur) => hasEvidence(found.lexEvidence) && found.lexTop && found.lexTop.type === 'policy' && found.lexTop.key !== cur;
      const aboutPage = page && !lexOther(page) && (cue || /이거|이건|이 사업|여기|이게/.test(q) || evidence(q, { key: page }).matched.length > 0 || top?.key === page);
      // 사업 이름 없이 이어 묻는 질문("어디서 신청해요?", "나는 받을 수 있어?")은 바로 앞에서 다룬 사업으로 본다
      const followUp = prev && !lexOther(prev) && (cue || /이거|이건|이 사업|그거|그건|그 사업/.test(q));
      if (mentioned.length) { target = mentioned[0]; how = 'mention'; }
      else if (aboutPage && !(define && helpHit)) { target = page; how = 'page'; }
      else if (followUp && !(define && helpHit)) { target = prev; how = 'prev'; }

      // 검색 1위를 얼마나 믿을지: single(바로 답) / cand(가까운 사업 몇 개를 후보로 보여 줌) / none(못 찾음)
      //  - 낱말 근거가 충분하면(confident) single. 드문 낱말 하나만 겹치면 cand
      //  - 의미 검색: 1위 유사도가 너무 낮으면 none. 1위가 뚜렷하면(z ≥ denseZ) single, 덜 뚜렷하면 cand
      //  - 낱말 검색만: 드문 낱말이 하나라도 겹치면 cand
      let trust = 'none';
      if (confident(ev)) trust = 'single';
      else if (found.dense) {
        const cos = found.natural ? found.natural.score : 0;
        if (cos >= opt.denseFloor) trust = found.z >= opt.denseZ ? 'single' : (found.z >= opt.candZ ? 'cand' : 'none');
      } else if (ev.specific >= 1) trust = 'cand';
      base.debug.trust = trust;

      // (6) 도움말 (용어·사용법)
      if (!target && !mentioned.length) {
        // 도움말은 낱말 하나가 우연히 겹쳐서 뜨는 일이 없게 '겹친 낱말 2개 이상'일 때만 (뜻을 묻는 질문이면 1개)
        const pick = define && helpHit ? helpHit : (topIsHelp ? top : null);
        const hev = pick ? evidence(q, pick) : null;
        if (pick && ((hev.specific >= 1 && (hev.matched.length >= 2 || define)) || (found.dense && pick === top && trust === 'single'))) {
          const h = byId.get(pick.key);
          return done('도움말', { kind: 'help', intent: 'help', text: h.say, sources: [src(h)], llm: { use: true, ...prompt(q, [h.text]) } });
        }
      }

      if (!target && top && top.type === 'policy' && trust === 'single') { target = top.key; how = 'search'; }

      // (7) 하나로 좁히지 못함 → 가까운 사업 후보를 보여 주거나(cand), 못 찾았다고 답한다(none)
      if (!target && ctx.profile && !third && !tag && GENERIC_LIST.test(bare) && !(trust === 'cand' && ev.anchor >= 1)) return openList('넓게 물은 질문 → 판정 엔진(지금 신청 가능)');
      if (!target) {
        const nearIds = found.ranked.filter((r) => r.type === 'policy').slice(0, 3).map((r) => r.key);
        if (trust === 'cand' && nearIds.length) {
          const list = nearIds.map((id, i) => `${'①②③'[i]} ${shortName(P.get(id).name)} — ${P.get(id).benefit}`).join(' ');
          return done('후보 제시', { kind: 'candidates', intent: 'find', policies: nearIds, cards: nearIds,
            text: `질문에 딱 맞는 사업 하나로 좁히지는 못했어요. ${found.dense ? '뜻이 가까운' : '낱말이 겹치는'} 사업은 이래요: ${list}. 찾던 사업이 있으면 이름을 눌러 보고, 없으면 사업 이름이나 "월세", "장학금" 같은 낱말로 다시 물어봐 주세요.`,
            sources: nearIds.slice(0, 2).map((id) => src(getChunk(id, 'overview'))), suggestions: nearIds.map((id) => `${shortName(P.get(id).name)} ${section ? SECTION_LABEL[section] : '알려줘'}`) });
        }
        if (trust === 'none') {
          const topicAny = UNCOLLECTED.find(([, re]) => re.test(bare));
          if (topicAny) {
            return done(`사업 모름 → 수집 안 한 주제(${topicAny[0]})`, { abstain: true, reason: 'uncollected', intent: 'unans',
              text: `'${topicAny[0]}'${hasFinal(topicAny[0]) ? '은' : '는'} 수집한 공고 자료에 없는 항목이에요. 해당 사업의 안산시청 공고 원문에서 확인해 주세요. 사업 이름을 알려 주시면 담당부서 연락처를 찾아 드릴게요.` });
          }
          const fewWords = wordTokens(bare).filter((w) => w.length >= 2).length <= 2;        // 낱말이 거의 없는 짧은 질문일 때만 되묻는다
          if (fewWords && (section || (!third && !/(거|것|게|사업|혜택)\s*(있|없)/.test(bare) && (CAN_GET.test(bare) || WHY_NOT.test(bare) || WHEN_OK.test(bare))))) {
            const what = section ? `어느 사업의 ${josa(SECTION_LABEL[section], '을', '를')} 찾는지` : '어느 사업을 말하는지';
            return done('어느 사업인지 되묻기', { abstain: true, reason: 'need_policy', intent: 'clarify',
              text: `${what} 사업 이름을 같이 알려 주세요. 예: "청년월세 지원사업 ${section ? SECTION_LABEL[section] : '나는 받을 수 있어?'}"` });
          }
        }
        return done('못 찾음', { abstain: true, reason: 'no_match', intent: 'oos', policies: nearIds, cards: nearIds,
          text: `수집한 안산시 청년 사업 ${policies.length}건에서 질문에 딱 맞는 내용은 찾지 못했어요.` + (nearIds.length ? ' 가장 가까운 사업은 아래와 같아요. 찾는 사업이 없으면 사업 이름이나 "월세", "장학금" 같은 낱말로 다시 물어봐 주세요.' : ' 사업 이름이나 "월세", "장학금" 같은 낱말로 다시 물어봐 주세요.') });
      }

      const p = P.get(target), r = judge(target, ctx);
      const mine = chunksOf.get(target);
      const others = found.ranked.filter((x) => x.type === 'policy' && x.key !== target).slice(0, 2).map((x) => x.key);
      const via = { mention: '사업 이름', page: '보고 있는 공고', prev: '앞 질문의 사업', search: found.dense ? '의미 검색 1위' : '낱말 검색 1위' }[how];
      // 판정 엔진이 보지 않는 조건(학적·취업·소득·가구·주택)을 붙여 물은 경우는 내 조건 판정으로 답하지 않는다
      const otherCond = how !== 'search' && saidAge == null && OTHER_COND.test(bare) && ASK_OK.test(bare) && !WHY_NOT.test(bare);
      const personal = !third && !otherCond && saidAge == null && (WHY_NOT.test(bare) || WHEN_OK.test(bare) || (CAN_GET.test(bare) && (firstPerson || how === 'page' || how === 'prev' || !section || MOVE_IN.test(bare))) || (firstPerson && ASK_OK.test(bare)));

      // (8) 수집하지 않은 주제 → 자료에 없다고 답한다
      const topic = UNCOLLECTED.find(([, re]) => re.test(bare) && !mine.some((c) => re.test(c.text.split('\n').slice(1).join(' '))));
      if (topic && !ctx.noGuard) {
        const contact = getChunk(target, 'contact');
        return done(`${via} → 수집 안 한 주제(${topic[0]})`, { kind: 'abstain', abstain: true, reason: 'uncollected', intent: 'unans', focus: target, policies: [target],
          text: `${shortName(p.name)}의 '${topic[0]}'${hasFinal(topic[0]) ? '은' : '는'} 수집한 공고 자료에 없어요. 안산시청 공고 원문에서 확인해 주세요.` + (contact ? ` ${contact.say}` : ''),
          sources: [contact, getChunk(target, 'method')].filter(Boolean).map(src), suggestions: suggestFor(target) });
      }

      // (9-1) 나이를 말하고 물은 질문: 내 생년월일이 아니라 말한 나이를 공고의 나이 조건에 대 본다 (거주 조건은 따로 안내)
      if (saidAge != null) {
        const t = getChunk(target, 'target'), at = ageText(p);
        const line = at == null ? `나이 제한이 없어서 만 ${saidAge}세도 나이 조건은 문제없어요.`
          : ageFits(p, saidAge) ? `만 ${saidAge}세는 나이 조건(${at})에 들어가요.` : `만 ${saidAge}세는 나이 조건(${at})에서 벗어나요.`;
        return done(`${via} → 말한 나이로 확인`, { kind: 'policy', intent: 'age', section: 'target', focus: target, policies: [target],
          text: `${shortName(p.name)}: ${line} 말한 나이를 만 나이로 봤고, 나이를 세는 기준일은 공고마다 달라서 경계에 있으면 원문을 확인해 주세요. ${t.say.replace(/^나이 조건은[^.]*\.\s*/, '')}`.trim(),
          sources: [src(t)], suggestions: suggestFor(target) });
      }

      // (9-2) 판정하지 않는 조건을 붙여 물은 질문: 공고의 '그 밖의 조건'을 먼저 보여 준다
      if (otherCond) {
        const t = getChunk(target, 'target'), oc = p.otherConditions || [];
        let text = `${shortName(p.name)}: 물어보신 조건은 제가 판정하지 않는 항목이에요(거주·나이만 판정해요). `;
        text += oc.length ? `공고에 적힌 그 밖의 조건은 ${oc.map((s) => `'${s}'`).join(', ')}${hasFinal(oc.at(-1)) ? '이에요' : '예요'}. 여기에 해당하는지 직접 확인해 주세요.`
          : '수집한 공고에는 거주·나이 말고 다른 조건이 적혀 있지 않아요. 정확한 내용은 원문에서 확인해 주세요.';
        if (r) text += ` 참고로 판정하는 항목은, ${verdictLine(r)}`;
        return done(`${via} → 판정하지 않는 조건`, { kind: 'policy', intent: 'cond', section: 'target', focus: target, policies: [target], text,
          sources: [src(t)], suggestions: suggestFor(target),
          llm: { use: true, ...prompt(q, r ? [t.text, judgeFact(target, r)] : [t.text]) } });
      }

      // (9-3) 내 조건 질문: 판정 결과를 근거로 설명
      if (personal && r) {
        const t = getChunk(target, 'target');
        let text = `${shortName(p.name)}: ${verdictLine(r)}`;
        if (r.status === 'eligible' || r.status === 'eligible_if_move_in') text += ` ${recruitLine(r)}`;
        if (r.selfCheck?.length) text += ` 그 밖에 ${r.selfCheck.map((s) => `'${s}'`).join(', ')} 조건은 직접 확인해야 해요.`;
        return done(`${via} → 판정 엔진`, { kind: 'judge', intent: WHY_NOT.test(bare) ? 'why_not' : WHEN_OK.test(bare) ? 'when_ok' : 'can_i', section: 'target', focus: target, policies: [target], text,
          sources: [src(t)], suggestions: suggestFor(target),
          llm: { use: true, ...prompt(q, [judgeFact(target, r), t.text]) } });
      }

      // (10) 사업 하나에 대한 사실 질문
      // 묻는 항목이 분명하면 그 섹션, 아니면 그 사업 안에서 점수가 가장 높은 청크(없으면 개요)
      const ranked = found.all.find((x) => x.key === target)?.chunks || [];
      let main = section ? getChunk(target, section) : null;
      if (!main) main = ranked[0]?.chunk || getChunk(target, 'overview');
      // 이름만 말했거나("○○ 알려줘") 검색으로 찾은 사업은 개요부터 보여 준다
      const residual = wordTokens(bare).filter((w) => w.length >= 2 && !/^(청년|안산|안산시|사업|지원|제도|프로그램|정책|소개|설명|정보)$/.test(w));
      if (!section && (how === 'search' || !residual.length)) main = getChunk(target, 'overview');
      // 모델에 줄 자료: 묻는 항목이 분명하면 그 섹션(+참고)만, 아니면 점수가 높은 청크 하나를 더 준다 (자료가 짧을수록 소형 모델이 덜 틀린다)
      const ctxChunks = [main];
      const second = section ? null : ranked.find((x) => x.chunk.id !== main.id && x.chunk.section !== 'overview')?.chunk;
      if (second) ctxChunks.push(second);
      const notes = getChunk(target, 'notes');
      if (notes && !ctxChunks.includes(notes) && ['benefit', 'target', 'period'].includes(main.section)) ctxChunks.push(notes);

      if (main.thin && !ctx.noGuard) {
        return done(`${via} → 자료가 빈 항목`, { kind: 'abstain', abstain: true, reason: 'thin', intent: 'unans', section: main.section, focus: target, policies: [target],
          text: `${shortName(p.name)}: ${main.say}`, sources: [main, getChunk(target, 'contact')].filter(Boolean).map(src), suggestions: suggestFor(target) });
      }

      const lead = bestLine(q, main);
      let text = `${shortName(p.name)}: ` + (lead && !main.say.includes(lead.replace(/^[^:]+:\s*/, '')) ? `${lead}. ` : '') + main.say;
      if (r && (main.section === 'period' || main.section === 'method')) text += ` ${recruitLine(r)}`;
      if (how === 'search' && others.length) text += ` 비슷한 사업: ${others.map((id) => shortName(P.get(id).name)).join(', ')}.`;
      const facts = ctxChunks.map((c) => c.text);
      if (r && (main.section === 'period' || main.section === 'method')) facts.push(`${p.name} | 오늘(${ctx.today}) 기준 모집 상태\n- ${recruitLine(r)}`);
      return done(`${via} → ${SECTION_LABEL[main.section]}`, { kind: 'policy', intent: how === 'search' && !section ? 'find' : 'fact', section: main.section, focus: target, policies: [target, ...(how === 'search' ? others : [])],
        cards: how === 'search' ? [target, ...others] : [], text, sources: ctxChunks.map(src), suggestions: suggestFor(target),
        llm: { use: true, ...prompt(q, facts) } });
    }

    return { answer, search, mentions, sectionOf, evidence, index, chunks, byId, prompt, SYSTEM, aliases: uniqueAliases };
  }

  // ============================================================
  // 5. 모델 답 검사: 답에 나온 숫자가 자료(와 질문)에 있는지
  // ============================================================
  // 숫자를 (값, 단위)로 읽는다. '20만원'과 날짜 속의 '20'을 구분하려고 단위까지 본다
  const UNIT_ALIAS = { '만': '만원', '억원': '억', '살': '세', '퍼센트': '%', '번': '회', '달': '개월' };
  const DATE_UNITS = new Set(['년', '월', '일']);
  function numTokens(text) {
    const src = String(text).replace(/\[\d+\]/g, ' ');
    const re = /(\d+(?:[.,]\d+)*)(\s*)(만\s*원|만|억\s*원|억|천\s*원|원|%|퍼센트|세|살|년|개월|달|월|일|회|번|명|건|가구|시간|분기|호|팀|점|배)?/g;
    const out = [];
    let m;
    while ((m = re.exec(src))) {
      let unit = (m[3] || '').replace(/\s+/g, '');
      unit = UNIT_ALIAS[unit] || unit;
      const raw = m[1], dots = (raw.match(/\./g) || []).length;
      if (dots >= 2 || (dots === 1 && /^(19|20)\d\d\./.test(raw))) {                       // 2026.03.30 같은 날짜
        const parts = raw.split('.').filter(Boolean);
        parts.forEach((p, k) => out.push({ v: String(parseInt(p, 10)), u: k === parts.length - 1 ? unit : '', at: m.index, end: re.lastIndex }));
      } else {
        const v = raw.includes('.') && !/,\d{3}/.test(raw) ? String(parseFloat(raw.replace(/,/g, ''))) : String(parseInt(raw.replace(/[.,]/g, ''), 10));
        out.push({ v, u: unit, at: m.index, end: re.lastIndex });
      }
    }
    // '18~34세', '1~2만원' 처럼 범위로 쓴 숫자는 뒤 숫자의 단위를 같이 쓴다
    for (let k = out.length - 2; k >= 0; k--) if (!out[k].u && /^\s*[~∼–-]\s*$/.test(src.slice(out[k].end, out[k + 1].at))) out[k].u = out[k + 1].u;
    return out;
  }
  function checkNumbers(answerText, contextText) {
    const ctx = numTokens(contextText), used = numTokens(answerText);
    const pairs = new Set(ctx.map((t) => t.v + '|' + t.u)), values = new Set(ctx.map((t) => t.v)), bare = new Set(ctx.filter((t) => !t.u).map((t) => t.v));
    const grounded = (t) => (t.u ? pairs.has(t.v + '|' + t.u) || (DATE_UNITS.has(t.u) && bare.has(t.v)) : values.has(t.v));
    const missing = [...new Set(used.filter((t) => !grounded(t)).map((t) => t.v + t.u))];
    return { total: used.length, missing, ok: missing.length === 0 };
  }
  // 답이 한국어인지: 한자·가나·키릴 문자가 없고, 한글이 영문자보다 많아야 한다 (LH·주소 같은 영문은 허용)
  function koreanOnly(text) {
    const t = String(text);
    if (/[぀-ヿ㐀-䶿一-鿿Ѐ-ӿ฀-๿]/.test(t)) return false;
    const plain = t.replace(/https?:\/\/[^\s)]+|[a-z0-9.-]+\.(?:go\.kr|or\.kr|net|com|kr|org)\b/gi, ' ');        // 주소는 세지 않는다
    const hangul = (plain.match(/[가-힣]/g) || []).length, latin = (plain.match(/[a-zA-Z]/g) || []).length;
    return hangul > 0 && hangul >= latin;
  }
  // "자료에 없다"는 뜻으로 답했는지
  const ABSTAIN_RE = /자료에(는|서|서는)?\s*.{0,12}(없어|없습|없는|없음|않아|않습)|(찾을|확인할|알|답할|답변할|말씀드릴|제공할|안내할)\s*수\s*(가\s*)?없|찾지\s*못|(나와|포함되어|적혀|언급되어|명시되어|기재되어)\s*있지\s*않|원문(에서|을)\s*확인|정보(가|는)\s*(없|부족)|다루지\s*않|모르겠/;

  // ============================================================
  // 6. 의미 검색용 문서 벡터 (build_embeddings.mjs 가 만든 embeddings_v3.json)
  //    질문 벡터는 브라우저에서 transformers.js 로 만들고, 여기서는 코사인 유사도만 계산한다
  // ============================================================
  function denseIndex(emb, chunkIds) {
    if (!emb || !emb.data) return null;
    if (chunkIds && (emb.ids.length !== chunkIds.length || emb.ids.some((id, i) => id !== chunkIds[i]))) return null;   // 코퍼스와 짝이 안 맞으면 쓰지 않는다
    const bin = atob(emb.data), n = emb.n, dim = emb.dim;
    const q = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) q[i] = (bin.charCodeAt(i) << 24) >> 24;
    const norms = new Float32Array(n);
    for (let i = 0; i < n; i++) { let t = 0; for (let j = 0; j < dim; j++) { const x = q[i * dim + j]; t += x * x; } norms[i] = Math.sqrt(t) || 1; }
    return {
      model: emb.model, file: emb.file, dtype: emb.dtype, queryPrefix: emb.queryPrefix || '', dim, n, downloadMB: emb.downloadMB,
      scores(vec) {
        let vn = 0; for (let j = 0; j < dim; j++) vn += vec[j] * vec[j]; vn = Math.sqrt(vn) || 1;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) { let t = 0; const o = i * dim; for (let j = 0; j < dim; j++) t += q[o + j] * vec[j]; out[i] = t / (norms[i] * vn); }
        return out;
      },
    };
  }

  return { create, denseIndex, tokenize, wordTokens, buildIndex, scoreAll, aliasesOf, checkNumbers, koreanOnly, ABSTAIN_RE, SECTION_LABEL, STATUS_LABEL };
})();
