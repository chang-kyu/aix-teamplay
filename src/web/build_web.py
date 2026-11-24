"""
웹 데모 빌드: template.html 에 judge.js 와 policies_v3.json 을 넣어 한 파일짜리 index.html 을 만든다.
데이터나 판정 규칙을 고친 뒤:  python build_v3.py  →  python web/build_web.py
챗봇 검색 자료(web/rag/corpus.json, emb.json)도 함께 넣는다.
※ 루트 index.html 은 빌드 결과물이라 직접 고치면 덮어써진다. 화면 수정은 web/template.html 에서.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tpl = (ROOT / "web" / "template.html").read_text(encoding="utf-8")
judge = (ROOT / "judge.js").read_text(encoding="utf-8")
judge = re.sub(r"^export\s+", "", judge, flags=re.M)          # 모듈 export 제거 → 일반 스크립트
data = json.loads((ROOT / "policies_v3.json").read_text(encoding="utf-8"))
data_js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

# 챗봇(AI 도우미) 검색용 자료: 사업 설명 조각(CORPUS)과 그 임베딩(EMB). web/rag/ 에 따로 보관.
def rag_js(name):
    f = ROOT / "web" / "rag" / name
    if not f.exists():
        return "null"
    obj = json.loads(f.read_text(encoding="utf-8"))
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

out = (tpl.replace("/*__JUDGE__*/", judge)
          .replace("/*__POLICIES__*/", data_js)
          .replace("/*__CORPUS__*/", rag_js("corpus.json"))
          .replace("/*__EMB__*/", rag_js("emb.json")))
for ph in ("__JUDGE__", "__POLICIES__", "__CORPUS__", "__EMB__"):
    assert ph not in out, ph
(ROOT / "web" / "index.html").write_text(out, encoding="utf-8")
print("web/index.html", len(out.encode("utf-8")), "bytes,", data["count"], "policies")
