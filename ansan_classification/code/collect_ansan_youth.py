"""
안산시청 청년정책(추진목록) + 고시·공고 수집 코드  (requests + BeautifulSoup + pandas)

※ 아래 URL·CSS selector는 2026-10-02에 실제 안산시청 페이지 HTML을 열어 확인한 값입니다.
   (Claude 작업 환경에서는 안산시청 접속이 막혀 있어서 이 파이썬 파일 자체는 실행해 보지 못했습니다.
    팀원 PC에서 실행해 보고 오류가 나면 selector를 다시 확인해 주세요.)
※ robots.txt: https://www.ansan.go.kr/robots.txt → "User-agent: * / Allow: /"
※ 저작권: 페이지 하단 '공공누리 제3유형(출처표시 + 변경금지)' → 출처(안산시청, URL) 반드시 표기
"""
import time
import re
import requests
import pandas as pd
from bs4 import BeautifulSoup

BASE = "https://www.ansan.go.kr"
HEADERS = {"User-Agent": "Mozilla/5.0 (student project: Ansan youth benefit notifier)"}
DELAY = 1.0  # 요청 사이 1초 쉬기 (서버 부담 방지)


def get_soup(url, params=None):
    """URL에 접속해서 BeautifulSoup 객체를 돌려준다."""
    res = requests.get(url, params=params, headers=HEADERS, timeout=15)
    res.raise_for_status()                 # 200이 아니면 에러 발생
    return BeautifulSoup(res.text, "html.parser")


# ---------------------------------------------------------------
# 1) 청년정책 추진목록 → 정책 53건의 이름·분야·상세페이지 ID
# ---------------------------------------------------------------
LIST_URL = BASE + "/www/common/cntnts/selectContents.do?cntnts_id=www01665"
CATEGORIES = ["참여권리", "교육일자리", "주거복지", "문화예술"]  # 페이지에 나오는 4개 분야


def collect_policy_list():
    soup = get_soup(LIST_URL)
    rows = []
    # 확인된 구조: <li><a href="...cntnts_id=C0001542"><span class="title">정책명</span> ...상세보기</a></li>
    for span in soup.select("li > a > span.title"):
        a = span.parent
        cid = re.search(r"cntnts_id=(\w+)", a["href"]).group(1)
        # 분야(참여권리 등)는 목록(ul) 앞쪽의 제목 텍스트에서 찾는다
        cat = None
        for prev in a.find_all_previous(string=True):
            if prev.strip() in CATEGORIES:
                cat = prev.strip()
                break
        rows.append({"category": cat,
                     "policy_name": span.get_text(" ", strip=True),
                     "source_id": cid,
                     "source_url": f"{BASE}/www/common/cntnts/selectContents.do?cntnts_id={cid}"})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------
# 2) 정책 상세페이지 → 사업개요/주요내용/담당부서 텍스트
#    확인된 구조: 본문은 <div id="contents" class="cts..."> 안의 또 다른 <div id="contents">
#    본문은 '추진배경 / 사업개요 / 주요내용 / 성과 및 기대효과 / 담당부서' 순서의 소제목으로 나뉨
# ---------------------------------------------------------------
SECTIONS = ["추진배경", "사업개요", "주요내용", "성과 및 기대효과", "담당부서"]


def collect_policy_detail(source_url):
    soup = get_soup(source_url)
    boxes = soup.select("div#contents")
    body = boxes[-1] if boxes else soup          # 가장 안쪽 #contents가 실제 본문
    for tag in body.select("style, script"):
        tag.decompose()
    lines = [l.strip() for l in body.get_text("\n").split("\n") if l.strip()]
    result, cur = {s: [] for s in SECTIONS}, None
    for line in lines:
        if line in SECTIONS:
            cur = line
        elif cur:
            result[cur].append(line)
    return {k: " / ".join(v) for k, v in result.items()}


# ---------------------------------------------------------------
# 3) 고시·공고 게시판(bbs_code=WWW13)에서 '청년' 제목 검색
#    확인된 파라미터: key=271, bbs_code=WWW13, sch_type=sj(제목), sch_text=검색어, currentPage=페이지
#    확인된 목록 구조: table tbody tr → td[0]번호, td[1]고시공고번호, td.p-subject a(제목), td[3]담당부서, td[4]작성일
#    제목 링크는 onclick="fnGoDetail( 1684218 )" → 이 숫자가 bbs_seq
# ---------------------------------------------------------------
NOTICE_LIST = BASE + "/www/common/bbs/selectPageListBbs.do"
NOTICE_DETAIL = BASE + "/www/common/bbs/selectBbsDetail.do"


def collect_notices(keyword="청년", max_pages=3):
    rows = []
    for page in range(1, max_pages + 1):
        params = {"key": 271, "bbs_code": "WWW13", "sch_type": "sj",
                  "sch_text": keyword, "currentPage": page}
        soup = get_soup(NOTICE_LIST, params)
        trs = soup.select("table tbody tr")
        for tr in trs:
            a = tr.select_one("td.p-subject a")
            if not a:
                continue
            seq = re.search(r"fnGoDetail\(\s*(\d+)", a.get("onclick", "")).group(1)
            tds = tr.find_all("td")
            rows.append({"notice_no": tds[1].get_text(strip=True),
                         "title": a.get_text(strip=True),
                         "department": tds[3].get_text(strip=True),
                         "posted_date": tds[4].get_text(strip=True),
                         "bbs_seq": seq,
                         "notice_url": f"{NOTICE_DETAIL}?key=271&bbs_code=WWW13&bbs_seq={seq}"})
        if len(trs) < 10:      # 마지막 페이지
            break
        time.sleep(DELAY)
    return pd.DataFrame(rows)


def collect_notice_body(notice_url):
    """공고 상세 → '내용' 칸 본문 텍스트 + 첨부파일 이름"""
    soup = get_soup(notice_url)
    body = soup.select("div#contents")[-1]
    text = body.get_text("\n")
    content = text.split("\n내용\n")[-1].split("\n파일\n")[0]   # '내용' ~ '파일' 사이가 본문
    files = sorted({t.strip() for t in body.find_all(string=re.compile(r"\.(hwpx?|pdf|xlsx?|docx?|zip)$"))})
    return re.sub(r"\s+", " ", content).strip(), ", ".join(files)


# ---------------------------------------------------------------
# 4) 공고 본문에서 조건 뽑기 (정규표현식 예시)
# ---------------------------------------------------------------
def parse_conditions(text):
    out = {}
    m = re.search(r"(\d{2})\s*[~∼-]\s*(\d{2})\s*세", text)            # 19~39세
    if m:
        out["min_age"], out["max_age"] = int(m.group(1)), int(m.group(2))
    m = re.search(r"중위소득\s*(\d{2,3})\s*%", text)                   # 중위소득 150%
    if m:
        out["max_income_ratio"] = int(m.group(1))
    dates = re.findall(r"(20\d{2})[.\s년]+(\d{1,2})[.\s월]+(\d{1,2})", text)  # 2026. 8. 1.
    if dates:
        ds = [f"{y}-{int(mo):02d}-{int(d):02d}" for y, mo, d in dates]
        out["first_date"], out["last_date"] = ds[0], ds[-1]
    out["is_unemployed_only"] = "미취업" in text
    out["is_ansan_resident"] = bool(re.search(r"안산시.{0,10}(주민등록|거주)", text))
    return out


if __name__ == "__main__":
    policies = collect_policy_list()
    print("정책 수:", len(policies))
    details = []
    for url in policies["source_url"]:
        details.append(collect_policy_detail(url))
        time.sleep(DELAY)
    policies = pd.concat([policies, pd.DataFrame(details)], axis=1)
    policies.to_csv("ansan_policy_raw.csv", index=False, encoding="utf-8-sig")

    notices = collect_notices("청년")
    bodies = []
    for url in notices["notice_url"]:
        bodies.append(collect_notice_body(url))
        time.sleep(DELAY)
    notices["body"], notices["files"] = zip(*bodies) if bodies else ([], [])
    parsed = notices["body"].apply(parse_conditions).apply(pd.Series)
    notices = pd.concat([notices, parsed], axis=1)
    notices.to_csv("ansan_notice_raw.csv", index=False, encoding="utf-8-sig")
    print("공고 수:", len(notices))
