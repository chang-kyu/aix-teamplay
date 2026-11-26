"""
공고 원문 전문 수집 (선택):  python rag/collect_fulltext.py      (code/v3 에서, 팀원 PC에서 실행)
- policies_v3.json 의 sourceUrl 52건을 1초 간격으로 열어 본문 글을 rag/raw/{사업 id}.txt 로 저장한다
- 저장한 뒤 python rag/build_corpus.py 를 다시 실행하면 '공고 원문' 청크가 코퍼스에 추가되어
  "제출 서류", "선발 방법"처럼 지금은 '자료에 없어요'라고 답하는 질문에도 원문을 찾아 보여 줄 수 있다

※ Claude 작업 환경에서는 안산시청 접속이 막혀 있어 이 파일은 실행해 보지 못했다. selector 는 03·05 문서에서 확인한 값이다.
※ 4차(2026-11-25): 같은 방식을 브라우저에서 돌려 52건을 모았다 → rag/fulltext_to_raw.py (서버·해외에서 접속이 막힐 때는 그쪽을 쓴다)
※ robots.txt: User-agent: * / Allow: /   · 이용조건: 공공누리 제3유형(출처표시 + 변경금지) → 글을 고치지 않고 출처 URL 과 함께 저장한다
※ 첨부(hwp/hwpx) 안의 세부 내용은 05 문서의 미리보기 변환 주소로 읽는다. 실패하면 본문만 저장한다.
"""
import json
import re
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
RAW = Path(__file__).resolve().parent / "raw"
BASE = "https://www.ansan.go.kr"
HEADERS = {"User-Agent": "Mozilla/5.0 (student project: Ansan youth benefit notifier)"}
DELAY = 1.0


def get(url, **kw):
    r = requests.get(url, headers={**HEADERS, **kw.pop("headers", {})}, timeout=20, **kw)
    r.raise_for_status()
    return r


def page_text(url):
    soup = BeautifulSoup(get(url).text, "html.parser")
    boxes = soup.select("div#contents")
    body = boxes[-1] if boxes else soup                      # 가장 안쪽 #contents 가 본문
    for tag in body.select("style, script"):
        tag.decompose()
    text = "\n".join(l.strip() for l in body.get_text("\n").split("\n") if l.strip())
    if "selectBbsDetail" in url and "\n내용\n" in text:       # 고시·공고: '내용' ~ '파일' 사이가 본문
        text = text.split("\n내용\n")[-1].split("\n파일\n")[0]
    file_ids = re.findall(r"fnOpenPreview\('([^']+)'\)", str(soup))
    return text, file_ids


def attachment_text(file_id):
    """첨부 미리보기(Synap 변환) → 쪽별 HTML 을 글로 (05 문서 3장)"""
    j = get(f"{BASE}/common/convertToHtmlAjax.do", params={"file_id": file_id}, headers={"X-Requested-With": "XMLHttpRequest"}).json()["resultMap"]
    base = BASE + j["rs"] + j["fn"]
    pages = int(re.search(r"<filespage_cnt>(\d+)", get(base + ".xml").text).group(1))
    out = []
    for n in range(1, pages + 1):
        html = get(f"{base}.files/{n}.html").content.decode("utf-8", "replace")
        out.append("\n".join(l.strip() for l in BeautifulSoup(html, "html.parser").get_text("\n").split("\n") if l.strip()))
        time.sleep(0.3)
    return "\n".join(out)


if __name__ == "__main__":
    RAW.mkdir(exist_ok=True)
    policies = json.loads((ROOT / "policies_v3.json").read_text(encoding="utf-8"))["policies"]
    for p in policies:
        out = RAW / f"{p['id']}.txt"
        if out.exists():
            continue
        try:
            text, file_ids = page_text(p["sourceUrl"])
            for fid in file_ids[:2]:                          # 첨부는 앞의 2개까지 (공고문·신청서 순서가 많다)
                try:
                    text += f"\n\n[첨부 {fid}]\n" + attachment_text(fid)
                except Exception as e:                        # PDF 등은 변환 결과가 비어 있다
                    print("  첨부 건너뜀", p["id"], fid, type(e).__name__)
            out.write_text(f"# {p['name']}\n# 출처: 안산시청 {p['sourceUrl']}\n# 수집일: {time.strftime('%Y-%m-%d')}\n\n{text}\n", encoding="utf-8")
            print("저장", out.name, len(text), "자")
        except Exception as e:
            print("실패", p["id"], type(e).__name__, e)
        time.sleep(DELAY)
