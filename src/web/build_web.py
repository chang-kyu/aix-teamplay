"""
웹 데모 빌드: template.html 에 judge.js 와 policies_v3.json 을 넣어 한 파일짜리 index.html 을 만든다.
데이터나 판정 규칙을 고친 뒤:  python build_v3.py  →  python web/build_web.py
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

out = tpl.replace("/*__JUDGE__*/", judge).replace("/*__POLICIES__*/", data_js)
assert "__JUDGE__" not in out and "__POLICIES__" not in out
(ROOT / "web" / "index.html").write_text(out, encoding="utf-8")
print("web/index.html", len(out.encode("utf-8")), "bytes,", data["count"], "policies")
