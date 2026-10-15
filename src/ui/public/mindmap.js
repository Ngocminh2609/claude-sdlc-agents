/**
 * Draws the run's mind map (built and computed server-side in
 * `src/ui/mind-map.ts`) as an SVG: the run on the left, its stages in the
 * middle, and each stage's tasks / groups / rounds on the right. The running
 * node is highlighted and pulses; every node carries its percentage.
 *
 * Only drawing and wording live here. A percentage with `estimate` is turns
 * used of the step's turn cap — the label and tooltip say so, because it is
 * not work done.
 */

const COL_X = [8, 232, 488];
const COL_W = [200, 228, 290];
const ROW_H = 46;
const NODE_H = 38;
const PAD_Y = 10;

const STATUS_WORD = { pending: "chưa tới", active: "đang chạy", done: "xong", failed: "dừng ở đây" };
const CHECK_TEXT = { pending: "KT build: chờ", active: "KT build: đang chạy", done: "KT build ✓", failed: "KT build ✗" };

const ESTIMATE_TIP =
  "Ước tính theo số lượt AI đã dùng trên giới hạn lượt của bước — cho biết đã tiêu bao nhiêu phần hạn mức, không phải đã làm xong bao nhiêu phần việc. Bước chỉ thành 100% khi thật sự kết thúc.";

/** What an item is called on screen. Task and group labels are data and shown as they are. */
function itemLabel(node) {
  const id = node.id;
  if (id.startsWith("task:")) return `${id.slice(5)} · ${node.label ?? ""}`;
  if (id === "gate:baseline") return "Kiểm build trước task đầu";
  if (id === "scan:reference-inventory") return "Quét repo mẫu";
  if (id === "scan:project-context") return "Quét dự án đích";
  let match = /^verify:(build|tests|fix):(\d+)$/.exec(id);
  if (match) {
    const what = { build: "Build", tests: "Unit test", fix: "Sửa lỗi" }[match[1]];
    return `${what} lần ${match[2]}`;
  }
  match = /^port:(.+)$/.exec(id);
  if (match) return `Nhóm ${node.label ?? match[1]}`;
  return node.label ?? id;
}

function percentText(node) {
  if (node.percent === null || node.percent === undefined) return node.status === "active" ? "đang chạy…" : "";
  const prefix = node.estimate && node.status !== "done" ? "≈" : "";
  const turns = node.turns && node.maxTurns && node.status === "active" ? ` · lượt ${node.turns}/${node.maxTurns}` : "";
  return `${prefix}${node.percent}%${turns}`;
}

function noteBadges(node) {
  const notes = node.notes;
  if (!notes) return "";
  const parts = [];
  if (notes.repeat) parts.push(`⟳${notes.repeat}`);
  if (notes.blocked) parts.push(`⛔${notes.blocked}`);
  if (notes.softCap) parts.push("⏱");
  return parts.join(" ");
}

function noteTip(node) {
  const notes = node.notes;
  if (!notes) return "";
  const lines = [];
  if (notes.repeat) lines.push(`⟳ ${notes.repeat} lần lặp lại cùng lệnh, cùng kết quả — đã nhắc AI đổi cách làm.`);
  if (notes.blocked) lines.push(`⛔ ${notes.blocked} lệnh bị chặn vì lặp quá nhiều lần.`);
  if (notes.softCap) lines.push("⏱ Đã dùng gần hết giới hạn lượt — đã nhắc AI chốt kết quả.");
  return lines.join("\n");
}

function truncate(text, width) {
  const max = Math.floor((width - 20) / 6.6);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const esc = (text) =>
  String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function nodeSvg(node, col, x, y, title, subtitle, tip) {
  const w = COL_W[col];
  const pct = node.percent ?? (node.status === "active" ? null : 0);
  const barW = w - 20;
  const fill = pct === null ? 0 : Math.max(0, Math.min(100, pct)) * (barW / 100);
  const badges = noteBadges(node);
  const tipText = [tip, node.estimate && node.status === "active" ? ESTIMATE_TIP : "", noteTip(node)]
    .filter(Boolean)
    .join("\n\n");
  return `
    <g class="mm-node" data-status="${node.status}" data-kind="${node.kind}" transform="translate(${x},${y - NODE_H / 2})">
      <title>${esc(tipText || title)}</title>
      <rect class="mm-box" width="${w}" height="${NODE_H}" rx="8" />
      <text class="mm-title" x="10" y="15">${esc(truncate(title, badges ? w - 40 : w))}</text>
      ${badges ? `<text class="mm-badges" x="${w - 8}" y="15" text-anchor="end">${esc(badges)}</text>` : ""}
      <rect class="mm-track" x="10" y="22" width="${barW}" height="4" rx="2" />
      <rect class="mm-bar${pct === null ? " mm-bar-indeterminate" : ""}" x="10" y="22" width="${pct === null ? barW : fill}" height="4" rx="2" />
      <text class="mm-sub" x="10" y="35">${esc(truncate(subtitle, w))}</text>
    </g>`;
}

function link(fromCol, fromY, toCol, toY, status) {
  const x1 = COL_X[fromCol] + COL_W[fromCol];
  const x2 = COL_X[toCol];
  const mid = (x1 + x2) / 2;
  return `<path class="mm-link" data-status="${status}" d="M${x1},${fromY} C${mid},${fromY} ${mid},${toY} ${x2},${toY}" />`;
}

/**
 * @param container element to draw into
 * @param map the state's `mindMap`
 * @param text `{ stage(id) -> {label, tip}, root -> {title, subtitle} }`
 */
export function renderMindMap(container, map, text) {
  if (!map || !map.children?.length) {
    container.innerHTML = "";
    return;
  }

  // One row per item; a stage with no items takes one row.
  let row = 0;
  const placed = map.children.map((stage) => {
    const rows = Math.max(1, stage.children.length);
    const top = row;
    row += rows;
    return { stage, top, rows };
  });
  const height = row * ROW_H + PAD_Y * 2;
  const rowY = (index) => PAD_Y + index * ROW_H + ROW_H / 2;
  const rootY = PAD_Y + (row * ROW_H) / 2;
  const width = COL_X[2] + COL_W[2] + 8;

  const links = [];
  const nodes = [];
  nodes.push(nodeSvg(map, 0, COL_X[0], rootY, text.root.title, text.root.subtitle, text.root.tip));

  for (const { stage, top, rows } of placed) {
    const y = rowY(top + (rows - 1) / 2);
    const words = text.stage(stage.id);
    links.push(link(0, rootY, 1, y, stage.status));
    const sub = [percentText(stage), stage.status !== "active" ? STATUS_WORD[stage.status] : ""].filter(Boolean).join(" · ");
    nodes.push(nodeSvg(stage, 1, COL_X[1], y, words.label, sub, words.tip));

    stage.children.forEach((item, index) => {
      const itemY = rowY(top + index);
      links.push(link(1, y, 2, itemY, item.status));
      const check = item.check ? CHECK_TEXT[item.check] : "";
      const sub2 = [percentText(item), check, item.status === "failed" ? STATUS_WORD.failed : ""].filter(Boolean).join(" · ");
      nodes.push(nodeSvg(item, 2, COL_X[2], itemY, itemLabel(item), sub2 || STATUS_WORD[item.status], itemLabel(item)));
    });
  }

  container.innerHTML = `
    <svg class="mm" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Sơ đồ tiến trình">
      ${links.join("")}
      ${nodes.join("")}
    </svg>`;
}
