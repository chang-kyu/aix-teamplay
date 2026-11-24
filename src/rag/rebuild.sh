#!/usr/bin/env bash
# AI 도우미 자료 다시 만들기 (src 폴더에서 실행): python build_v3.py 다음, python web/build_web.py 전에.
#  1) CORPUS: policies_v3.json 으로 매번 다시 만든다 (몇 초)
#  2) EMB: CORPUS 내용이 지난번 EMB를 만들 때와 달라졌을 때만 다시 만든다 (모델 111MB 내려받기 + 1~2분)
#     실패해도 빌드는 계속한다 → build_web.py 가 짝이 안 맞는 EMB는 빼고(의미 검색 꺼짐) 만든다.
set -euo pipefail
python rag/build_corpus.py > /dev/null
now=$(sha256sum corpus_v3.json | cut -d' ' -f1)
was=$(cat rag/emb_source.sha256 2>/dev/null || true)
if [ "$now" = "$was" ] && [ -f embeddings_v3.json ]; then
  echo "EMB: 코퍼스가 그대로라 다시 만들지 않음"
  exit 0
fi
echo "EMB: 코퍼스가 바뀌어 다시 만듦"
if [ ! -d node_modules/@huggingface/transformers ]; then
  npm i --no-save --no-package-lock --silent @huggingface/transformers@4.3.2 || { echo "::warning::transformers.js 설치 실패 — 의미 검색 자료를 갱신하지 못했어요"; exit 0; }
fi
if node rag/build_embeddings.mjs > /tmp/emb.log 2>&1; then
  echo "$now" > rag/emb_source.sha256
  tail -n 5 /tmp/emb.log
else
  tail -n 20 /tmp/emb.log
  echo "::warning::의미 검색 자료(EMB)를 다시 만들지 못했어요. 낱말 검색은 최신 데이터로 동작해요."
fi
