// ── Minimal markdown renderer ──
function renderMarkdown(text) {
  const ESC = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>');

  // Extract code blocks first to avoid mangling them
  const blocks = [];
  const s0 = text.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${ESC(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  // Split into lines and process
  const lines = s0.split('\n');
  const out = [];
  let inUl = false, inOl = false, inTable = false, tableBuf = [], pBuf = [];
  let inSubUl = false;

  function flushP() {
    if (!pBuf.length) return;
    const joined = pBuf.join('\n').trim();
    if (joined) out.push(`<p>${inline(ESC(joined))}</p>`);
    pBuf = [];
  }
  function closeSubList() {
    if (inSubUl) { out.push('</ul></li>'); inSubUl = false; }
  }
  function closeList() {
    closeSubList();
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }
  function flushTable() {
    if (!tableBuf.length) return;
    const rows = tableBuf;
    tableBuf = []; inTable = false;
    if (rows.length < 2) { out.push(`<p>${rows.map(r => ESC(r)).join('<br>')}</p>`); return; }
    const parseRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headers = parseRow(rows[0]);
    // rows[1] is the separator (---|---), skip it
    const body = rows.slice(2);
    const ths = headers.map(h => `<th>${inline(ESC(h))}</th>`).join('');
    const trs = body.map(r => `<tr>${parseRow(r).map(c => `<td>${inline(ESC(c))}</td>`).join('')}</tr>`).join('');
    out.push(`<div class="md-table-wrap"><button class="md-table-expand" onclick="expandTable(this)">⤢ Expand</button><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
  }
  // Append text as a detail line under the last <li>
  function appendToLastLi(text) {
    // Find last </li> and inject before it
    for (let j = out.length - 1; j >= 0; j--) {
      if (out[j].endsWith('</li>')) {
        out[j] = out[j].slice(0, -5) + `<div class="li-detail">${inline(ESC(text))}</div></li>`;
        return true;
      }
    }
    return false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Restore code block placeholder
    if (/^\x00BLOCK\d+\x00$/.test(line.trim())) {
      flushP(); closeList();
      const idx = parseInt(line.match(/\d+/)[0]);
      out.push(blocks[idx]);
      continue;
    }

    // Table rows (start with |)
    if (/^\|/.test(line)) {
      flushP(); closeList();
      inTable = true;
      tableBuf.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Headings
    const hm = line.match(/^(#{1,6}) (.+)$/);
    if (hm) { flushP(); closeList(); const lvl = Math.min(hm[1].length, 6); out.push(`<h${lvl}>${inline(ESC(hm[2]))}</h${lvl}>`); continue; }

    // HR
    if (/^---+$/.test(line.trim())) { flushP(); closeList(); out.push('<hr>'); continue; }

    // Sub-list item (indented * or -)
    const subUlm = line.match(/^[ \t]+[\*\-] (.+)$/);
    if (subUlm && (inUl || inOl)) {
      if (!inSubUl) {
        // Reopen last <li> to nest a <ul> inside it
        for (let j = out.length - 1; j >= 0; j--) {
          if (out[j].endsWith('</li>')) { out[j] = out[j].slice(0, -5); break; }
        }
        out.push('<ul>');
        inSubUl = true;
      }
      out.push(`<li>${inline(ESC(subUlm[1]))}</li>`);
      continue;
    }

    // Unordered list item
    const ulm = line.match(/^[\*\-] (.+)$/);
    if (ulm) {
      // If inside an ol, treat as a detail line under the last li
      if (inOl) { closeSubList(); appendToLastLi(ulm[1]); continue; }
      flushP();
      closeSubList();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ESC(ulm[1]))}</li>`);
      continue;
    }

    // Ordered list item
    const olm = line.match(/^\d+\. (.+)$/);
    if (olm) {
      flushP();
      closeSubList();
      if (!inOl) { closeList(); out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(ESC(olm[1]))}</li>`);
      continue;
    }

    // Blank line - only close list if next non-blank line is NOT another list item
    if (line.trim() === '') {
      flushP();
      // Peek ahead: if next non-blank line is a list item of same type, keep list open
      let next = '';
      for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim()) { next = lines[j]; break; } }
      const nextIsOl = /^\d+\. /.test(next);
      const nextIsUl = /^[\*\-] /.test(next);
      if ((inOl && !nextIsOl) || (inUl && !nextIsUl)) closeList();
      continue;
    }

    // Regular text inside a list = detail line; otherwise paragraph
    if ((inOl || inUl) && appendToLastLi(line)) continue;
    closeList();
    pBuf.push(line);
  }
  flushP(); closeList(); flushTable();

  return out.join('');
}

