"""
웹 데모 빌드: template.html 에 판정 엔진·데이터·질의응답 엔진·코퍼스를 넣어 한 파일짜리 index.html 을 만든다.
데이터나 판정 규칙을 고친 뒤:
  python build_v3.py                 (policies_v3.json)
  python rag/build_corpus.py         (corpus_v3.json — AI 도우미가 찾는 청크)
  node rag/build_embeddings.mjs      (embeddings_v3.json — 의미 검색용 문서 벡터. 코퍼스가 바뀌면 다시)
  python web/build_web.py            (web/index.html)
템플릿에 자리(/*__RAG__*/ 등)가 없으면 그 부분은 건너뛴다 → 11/24 이전 템플릿도 그대로 빌드된다.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def js_module(path):
    """모듈 export 를 떼어 일반 스크립트로"""
    return re.sub(r"^export\s+", "", path.read_text(encoding="utf-8"), flags=re.M)


def js_data(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


tpl = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
data = json.loads((ROOT / "policies_v3.json").read_text(encoding="utf-8"))
out = tpl.replace("/*__JUDGE__*/", js_module(ROOT / "judge.js")).replace("/*__POLICIES__*/", js_data(data))
note = ""

if "/*__RAG__*/" in out:                                   # AI 도우미가 있는 템플릿
    corpus = json.loads((ROOT / "corpus_v3.json").read_text(encoding="utf-8"))
    assert corpus["asOf"] == data["asOf"] and corpus["policyCount"] == data["count"], "corpus_v3.json 이 policies_v3.json 과 달라요. python rag/build_corpus.py 를 다시 실행하세요."
    emb_path, emb = ROOT / "embeddings_v3.json", None
    if emb_path.exists():
        emb = json.loads(emb_path.read_text(encoding="utf-8"))
        if emb["ids"] != [c["id"] for c in corpus["chunks"]]:
            print("! embeddings_v3.json 이 코퍼스와 맞지 않아 뺐어요 (의미 검색 꺼짐). node rag/build_embeddings.mjs 를 다시 실행하세요.")
            emb = None
    out = (out.replace("/*__RAG__*/", js_module(ROOT / "rag" / "rag.js"))
              .replace("/*__CORPUS__*/", js_data(corpus))
              .replace("/*__EMBEDDINGS__*/", js_data(emb) if emb else "null"))
    note = f", {corpus['chunkCount']} chunks, 의미 검색 {'포함' if emb else '없음'}"

left = re.findall(r"/\*__[A-Z]+__\*/", out)
assert not left, f"채우지 못한 자리: {left}"
(ROOT / "web" / "index.html").write_text(out, encoding="utf-8")
print("web/index.html", len(out.encode("utf-8")), "bytes,", data["count"], "policies" + note)
