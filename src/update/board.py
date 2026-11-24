"""
안산시청 고시·공고 게시판(key=271, bbs_code=WWW13) 읽기.

- 목록: selectPageListBbs.do?...&currentPage=N  (한 페이지 15건, 서버에서 HTML로 그려 줌)
- 상세: selectBbsDetail.do?...&bbs_seq=N        (표: 고시공고번호·담당부서·제목·내용·파일)
- 첨부 미리보기(hwp·hwpx·pdf → HTML): /common/convertToHtmlAjax.do?file_id=… → {fn, rs}
  → {rs}{fn}.xml (페이지 수) → {rs}{fn}.files/{1..N}.html

외부 라이브러리 없이 표준 라이브러리만 쓴다 (GitHub Actions에서 설치 없이 실행).
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
import urllib.request

HOST = "https://www.ansan.go.kr"
LIST_URL = HOST + "/www/common/bbs/selectPageListBbs.do?key=271&bbs_code=WWW13&currentPage={page}"
DETAIL_URL = HOST + "/www/common/bbs/selectBbsDetail.do?key=271&bbs_code=WWW13&bbs_seq={seq}"
PREVIEW_URL = HOST + "/common/convertToHtmlAjax.do?file_id={fid}"

UA = "Mozilla/5.0 (compatible; ansan-benefit-bot/1.0; +https://github.com/chang-kyu/aix-teamplay)"
DELAY = 0.7          # 요청 사이 쉬는 시간(초). 시청 서버에 부담 주지 않기


class FetchError(RuntimeError):
    pass


def _get(url: str, timeout: int = 20, retries: int = 2) -> str:
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                charset = r.headers.get_content_charset() or "utf-8"
            time.sleep(DELAY)
            return body.decode(charset, errors="replace")
        except Exception as e:  # 네트워크 오류는 몇 번 다시 시도
            last = e
            time.sleep(1.5 * (i + 1))
    raise FetchError(f"{url} 읽기 실패: {last}")


def text_of(fragment: str) -> str:
    """HTML 조각 → 읽을 수 있는 글자. 블록 태그는 줄바꿈으로."""
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", fragment)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</tr>|</h\d>|</div>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s).replace("\xa0", " ")
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


# ---------------- 목록 ----------------
_ROW = re.compile(r"(?is)<tr>(.*?)</tr>")
_FIELD = lambda name: re.compile(r'(?is)<td[^>]*data-field="%s"[^>]*>(.*?)</td>' % name)


def parse_list(page_html: str) -> list[dict]:
    m = re.search(r"(?is)<tbody[^>]*>(.*?)</tbody>", page_html)
    if not m:
        return []
    posts = []
    for row in _ROW.findall(m.group(1)):
        sj = _FIELD("SJ").search(row)
        if not sj:
            continue
        seq = re.search(r"fnGoDetail\(\s*(\d+)\s*\)", sj.group(1))
        if not seq:
            continue
        get = lambda f: (lambda x: text_of(x.group(1)) if x else "")(_FIELD(f).search(row))
        posts.append({
            "seq": int(seq.group(1)),
            "no": get("NO"),
            "noticeNo": get("ADITFIELD4"),
            "title": text_of(sj.group(1)),
            "dept": get("ADITFIELD5"),
            "date": get("REGIST_DT"),
            "url": DETAIL_URL.format(seq=seq.group(1)),
        })
    return posts


def fetch_list(page: int) -> list[dict]:
    return parse_list(_get(LIST_URL.format(page=page)))


def fetch_new_posts(last_seq: int | None, max_pages: int = 10, since: str | None = None) -> list[dict]:
    """last_seq 보다 큰 글번호만 모은다. 목록은 최신순이라 last_seq를 만나면 멈춘다.
    처음 실행(last_seq 없음)이면 since(YYYY-MM-DD) 이후 글까지만."""
    out, seen = [], set()
    for page in range(1, max_pages + 1):
        rows = fetch_list(page)
        if not rows:
            break
        stop = False
        for p in rows:
            if p["seq"] in seen:
                continue
            seen.add(p["seq"])
            if last_seq is not None and p["seq"] <= last_seq:
                continue          # 같은 날 글 순서가 섞여 있어서 바로 멈추지 않고 이 페이지는 끝까지 본다
            if since and p["date"] and p["date"] < since:
                stop = True
                continue
            out.append(p)
        if last_seq is not None and all(p["seq"] <= last_seq for p in rows):
            break
        if stop:
            break
    return out


# ---------------- 상세 ----------------
def parse_detail(page_html: str) -> dict:
    m = re.search(r'(?is)<div class="[^"]*bbs__view[^"]*">(.*)', page_html)
    view = m.group(1) if m else page_html
    fields = {}
    for th, td in re.findall(r'(?is)<th[^>]*scope="row"[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>', view):
        fields[text_of(th)] = td
    files = []
    for fid, name in re.findall(
            r"(?is)fnFileDownLoad\('([^']+)'\).*?<span[^>]*p-icon[^>]*>.*?</span>\s*<span>(.*?)</span>", view):
        files.append({"fileId": fid, "name": text_of(name)})
    return {
        "noticeNo": text_of(fields.get("고시공고번호", "")),
        "dept": text_of(fields.get("담당부서", "")),
        "title": text_of(fields.get("제목", "")),
        "body": text_of(fields.get("내용", "")),
        "files": files,
    }


def fetch_detail(seq: int) -> dict:
    d = parse_detail(_get(DETAIL_URL.format(seq=seq)))
    d["seq"], d["url"] = seq, DETAIL_URL.format(seq=seq)
    return d


def pick_notice_file(files: list[dict]) -> dict | None:
    """공고문 본문일 가능성이 높은 첨부 하나 고르기 (신청서·포스터·목록 엑셀 제외)."""
    docs = [f for f in files if re.search(r"\.(hwpx?|pdf|docx?)$", f["name"], re.I)]
    if not docs:
        return None
    def score(f):
        n = f["name"]
        s = 0
        if re.search(r"공고|안내|모집", n): s += 3
        if re.search(r"신청서|동의서|서식|계획서|양식|목록|포스터", n): s -= 3
        if n.lower().endswith((".hwpx", ".hwp")): s += 1      # 미리보기 변환이 가장 잘 됨
        return s
    return max(docs, key=score)


def fetch_attachment_text(file_id: str, max_pages: int = 4, max_chars: int = 8000) -> str:
    meta = json.loads(_get(PREVIEW_URL.format(fid=urllib.parse.quote(file_id))))
    if (meta.get("resultStats") or {}).get("resultCode") != "success":
        raise FetchError("미리보기 변환 실패: " + str(meta.get("resultStats")))
    rm = meta["resultMap"]
    base = HOST + rm["rs"] + rm["fn"]
    idx = _get(base + ".xml")
    n = int((re.search(r"<filespage_cnt>(\d+)</filespage_cnt>", idx) or [0, "1"])[1])
    parts = []
    for i in range(1, min(n, max_pages) + 1):     # 0.html 은 빈 머리말
        try:
            parts.append(text_of(_get(f"{base}.files/{i}.html")))
        except FetchError:
            break
        if sum(map(len, parts)) > max_chars:
            break
    return "\n".join(parts)[:max_chars]
