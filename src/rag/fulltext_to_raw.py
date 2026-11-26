"""
공고 원문을 브라우저에서 모으는 방법 (안산시청 누리집이 해외·서버 접속을 막을 때):  4차(2026-11-25)에 이 방법으로 모았다.

  1) python rag/fulltext_to_raw.py --make-js > collect.js
  2) 크롬에서 https://www.ansan.go.kr 아무 쪽이나 열고, 개발자 도구(F12) → Console 에 collect.js 내용을 붙여 넣고 Enter
     → 52건의 본문과 첨부(미리보기 변환, 앞의 2개)를 같은 사이트 안에서 차례로 읽어 1분쯤 뒤 ansan_fulltext.json 이 내려받아진다
  3) python rag/fulltext_to_raw.py 내려받은/ansan_fulltext.json   → rag/raw/{사업 id}.txt (collect_fulltext.py 와 같은 모양)
  4) python rag/build_corpus.py → node rag/build_embeddings.mjs → python web/build_web.py

읽는 방식은 collect_fulltext.py 와 같다: 가장 안쪽 div#contents 의 글, 고시·공고는 '내용'~'파일' 사이, 첨부는 convertToHtmlAjax.do 미리보기.
공공누리 제3유형(출처표시 + 변경금지) → 글을 고치지 않고 출처 URL 과 함께 저장한다.
"""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent

JS = r"""(() => {
const L = __LIST__;
const st = window.__ft = { started: Date.now(), done: 0, total: L.length, res: {}, running: true };
const lines = (root) => { const doc = root.ownerDocument || root; const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT); const out = []; let n; while ((n = w.nextNode())) { const p = n.parentNode && n.parentNode.nodeName; if (p === 'SCRIPT' || p === 'STYLE' || p === 'NOSCRIPT') continue; for (const l of n.nodeValue.split('\n')) { const s = l.trim(); if (s) out.push(s); } } return out.join('\n'); };
const get = async (u, opt = {}) => { const r = await fetch(u, { credentials: 'same-origin', ...opt }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u); return r; };
async function att(fid) {
  const j = await (await get('/common/convertToHtmlAjax.do?file_id=' + encodeURIComponent(fid), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })).json();
  const m = j.resultMap; const base = m.rs + m.fn;
  const xml = await (await get(base + '.xml')).text();
  const pages = +((xml.match(/<filespage_cnt>(\d+)/) || [])[1] || 0);
  const out = [];
  for (let k = 1; k <= pages; k++) { const html = await (await get(base + '.files/' + k + '.html')).text(); out.push(lines(new DOMParser().parseFromString(html, 'text/html').body)); }
  return { pages, text: out.join('\n') };
}
(async () => {
  for (const [id, path] of L) {
    const rec = st.res[id] = { path, text: '', fids: [], att: [] };
    try {
      const html = await (await get(path)).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const boxes = doc.querySelectorAll('div#contents');
      const body = boxes.length ? boxes[boxes.length - 1] : doc.body;
      let text = lines(body);
      if (path.includes('selectBbsDetail') && text.includes('\n내용\n')) text = text.split('\n내용\n').pop().split('\n파일\n')[0];
      rec.text = text;
      rec.fids = [...html.matchAll(/fnOpenPreview\('([^']+)'\)/g)].map((m) => m[1]);
      for (const fid of rec.fids.slice(0, 2)) { try { const a = await att(fid); rec.att.push({ fid, pages: a.pages, text: a.text }); } catch (e) { rec.att.push({ fid, pages: 0, text: '', err: String(e).slice(0, 160) }); } }
    } catch (e) { rec.err = String(e).slice(0, 160); }
    st.done++;
    console.log('원문', st.done + '/' + st.total, id, rec.text.length, '자', rec.err || '');
  }
  const out = { version: 1, source: location.origin, collectedAt: new Date().toISOString(), note: '공공누리 제3유형 — 글을 고치지 않고 출처와 함께 쓴다', items: st.res };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })); a.download = 'ansan_fulltext.json'; document.body.appendChild(a); a.click();
  st.running = false; console.log('끝: ansan_fulltext.json 을 내려받았어요');
})();
})();
"""


def make_js():
    policies = json.loads((ROOT / "policies_v3.json").read_text(encoding="utf-8"))["policies"]
    lst = []
    for p in policies:
        u = urlparse(p["sourceUrl"])
        lst.append([p["id"], u.path + ("?" + u.query if u.query else "")])
    return JS.replace("__LIST__", json.dumps(lst, ensure_ascii=False, separators=(",", ":")))


def to_raw(src):
    d = json.loads(Path(src).read_text(encoding="utf-8"))
    pol = {p["id"]: p for p in json.loads((ROOT / "policies_v3.json").read_text(encoding="utf-8"))["policies"]}
    raw = ROOT / "rag" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    day = d["collectedAt"][:10]
    n, skipped = 0, []
    for pid, v in d["items"].items():
        text = (v.get("text") or "").strip()
        for a in v.get("att", [])[:2]:
            if a.get("text"):
                text += f"\n\n[첨부 {a['fid']}]\n" + a["text"].strip()
        if not text.strip() or pid not in pol:
            skipped.append(pid)
            continue
        p = pol[pid]
        (raw / f"{pid}.txt").write_text(f"# {p['name']}\n# 출처: 안산시청 {p['sourceUrl']}\n# 수집일: {day}\n\n{text}\n", encoding="utf-8")
        n += 1
    print("rag/raw 에", n, "개 저장 | 글이 없어 건너뜀:", skipped)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--make-js":
        sys.stdout.write(make_js())
    elif len(sys.argv) > 1:
        to_raw(sys.argv[1])
    else:
        print(__doc__)
