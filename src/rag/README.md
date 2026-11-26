# AI 도우미 데이터: CORPUS · EMB 만드는 코드

`index.html` 안의 `const CORPUS = …`(검색 자료)와 `const EMB = …`(의미 검색용 문서 벡터)는 이 폴더의 코드로 만든다. 명령은 모두 `src` 폴더에서 실행한다.

| 순서 | 명령 | 만드는 파일 | index.html 안의 이름 | 언어 |
|---|---|---|---|---|
| 1 | `python build_v3.py` | `policies_v3.json` (사업 52건) | `DATA` | Python |
| 2 | `python rag/build_corpus.py` | `corpus_v3.json` (청크 910개 = 사업 정리 439 + 공고 원문 471) | `CORPUS` | Python |
| 3 | `node rag/build_embeddings.mjs` | `embeddings_v3.json` (공고 원문을 뺀 청크 439개마다 768차원 벡터, int8) | `EMB` | Node.js |
| 4 | `python web/build_web.py` | `web/index.html` | — | Python |

- 3번을 처음 돌릴 때는 먼저 `npm i @huggingface/transformers@4.3.2`를 실행한다. 3번은 검색 모델 `jhgan/ko-sroberta-multitask`(약 111MB)를 허깅페이스에서 내려받는다.
- **EMB만 Node.js로 만든 이유**: 웹 화면은 사용자 질문의 벡터를 브라우저에서 transformers.js 4.3.2로 만든다. 문서 벡터도 같은 라이브러리와 같은 ONNX 파일로 만들어야 두 벡터를 그대로 비교할 수 있다.
- 4번이 만든 `web/index.html`을 저장소 맨 위 `index.html` 자리에 올리면 배포된다.
- 코퍼스를 고치면 3번도 다시 돌려야 한다. 코퍼스와 EMB의 짝이 맞지 않으면 4번이 의미 검색을 빼고 만든다.
- **공고 원문(`raw/`)**: 안산시청 사업 페이지 글 51건(2026-11-25 수집, ANS033은 글이 없어 뺌). 2번이 400자 안팎으로 잘라 '공고 원문' 청크로 넣는다. 사업을 찾는 검색과 EMB에는 쓰지 않고, 사업이 정해진 뒤 정리한 항목에 없는 질문(제출 서류·4대보험·사용처 등)에 원문 일부를 보여 줄 때만 쓴다. 다시 모으는 방법은 `fulltext_to_raw.py` 맨 위 설명에 있다 (명령은 `src` 폴더에서).

## 자동 빌드에서

GitHub Actions(데이터 다시 빌드·데이터 점검)는 `python build_v3.py` 다음에 `bash rag/rebuild.sh`를 돌린다. CORPUS는 매번 다시 만들고, EMB는 `corpus_v3.json`이 `rag/emb_source.sha256`에 적힌 것과 달라졌을 때만 다시 만든다. EXTRA에 없는 사업(자동으로 추가된 새 사업)은 경고만 하고 기본 정보로 청크를 만든다.

## 파일

| 파일 | 내용 |
|---|---|
| `build_corpus.py` | 사업 52건을 개요·지원 대상·지원 내용·신청 기간·신청 방법·문의처·참고 청크로 나누고, 도움말 9개와 범위 밖 예시 91개를 더한다. 신청 방법·담당부서·검색어 같은 설명용 값은 이 파일의 `EXTRA`에서 고친다 |
| `build_embeddings.mjs` | 청크마다 문서 벡터를 계산해 int8로 줄여 저장한다. 평가 질문으로 검색 정확도(hit@1·3·5)도 함께 출력한다 |
| `rag.js` | 화면의 질의응답 엔진(검색·답 조립). 3번이 평가에 쓰고, 4번이 index.html에 넣는다 |
| `eval_set.json` | 검색 평가 질문 114개 (dev 43 · test 43 · hard 28). 3번이 읽는다 |
| `raw/` | 공고 원문 51건 (`ANS001.txt` …, 맨 위 세 줄에 사업 이름·출처·수집일). 2번이 '공고 원문' 청크로 넣는다 |
| `fulltext_to_raw.py` · `collect_fulltext.py` | 공고 원문 다시 모으기. 안산시청이 서버 접속을 막을 때는 `fulltext_to_raw.py`(브라우저에서 모으기)를 쓴다 |
| `../web/build_web.py` | `web/template.html`에 판정 엔진·데이터·rag.js·CORPUS·EMB를 넣어 한 파일짜리 index.html을 만든다 |

## 재현 확인 (2026-11-25)

이 저장소의 코드로 1~4를 다시 실행해서 배포된 `index.html`과 비교했다.

- `corpus_v3.json` = `index.html`의 `CORPUS` (글자 하나까지 같음)
- `embeddings_v3.json` = `index.html`의 `EMB` (벡터 값 337,152바이트 모두 같음)
- `web/index.html` = 저장소 맨 위 `index.html` (바이트까지 같음)
