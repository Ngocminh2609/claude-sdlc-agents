// Front end for the aidev pipeline console.
//
// No framework and no build step on purpose: the server serves these three
// files straight from src/ui/public, the same way the `aidev` command runs
// src/ through tsx. Adding a bundler here would put a build between editing
// the UI and seeing it, for a page this size.
//
// Every user-facing string lives in this file (the UI is Vietnamese, the rest
// of the repo is English). The server sends ids and status codes; the wording
// is decided here, so there is exactly one place to look for it.

const $ = (id) => document.getElementById(id);

const el = {
  topbarMeta: $("topbar-meta"),
  tabs: $("tabs"),
  quickstart: $("quickstart"),
  modeSwitch: $("mode-switch"),
  stepRunNum: $("step-run-num"),
  projectBe: $("project-be"),
  projectFe: $("project-fe"),
  specPath: $("spec-path"),
  referencePath: $("reference-path"),
  cloneWhat: $("clone-what"),
  cloneFromBe: $("clone-from-be"),
  cloneFromFe: $("clone-from-fe"),
  cloneSkipBuild: $("clone-skip-build"),
  cloneSkipTests: $("clone-skip-tests"),
  dbMode: $("db-mode"),
  dbConnection: $("db-connection"),
  dbConnectionRow: $("db-connection-row"),
  dbConnectionHint: $("db-connection-hint"),
  dbReveal: $("db-reveal"),
  dbSchemaRow: $("db-schema-row"),
  dbSchemaPath: $("db-schema-path"),
  precheck: $("precheck"),
  metadataStandardsMode: $("metadata-standards-mode"),
  presetSelect: $("preset-select"),
  runStart: $("run-start"),
  runStop: $("run-stop"),
  runMeta: $("run-meta"),
  runError: $("run-error"),
  statusPill: $("status-pill"),
  stages: $("stages"),
  result: $("result"),
  log: $("log"),
  logOnlyProgress: $("log-only-progress"),
  logFollow: $("log-follow"),
  specEditor: $("spec-editor"),
  specFilePath: $("spec-file-path"),
  specStatus: $("spec-status"),
  runList: $("run-list"),
  report: $("report"),
  reportTitle: $("report-title"),
  picker: $("picker"),
  pickerTitle: $("picker-title"),
  pickerPath: $("picker-path"),
  pickerList: $("picker-list"),
  pickerError: $("picker-error"),
  pickerChoose: $("picker-choose"),
};

// --- Wording ---------------------------------------------------------------

const STAGE_TEXT = {
  inventory: {
    label: "1. Kiểm kê repo mẫu",
    tip: "Quét repo mẫu một lần, lập danh sách file cần clone cho các giai đoạn sau. Bỏ qua khi không khai báo repo mẫu.",
  },
  "specs-arch": { label: "2. Thiết kế & kiến trúc", tip: "Đọc spec và mã nguồn, đề xuất phương án." },
  review: {
    label: "3. Duyệt thiết kế",
    tip: "Một AI khác review phương án, tối đa 3 lần. Lỗi nhỏ đã rõ cách sửa thì duyệt kèm yêu cầu sửa, chỉ reject khi cần thiết kế lại.",
  },
  tasks: { label: "4. Chia việc", tip: "Cắt thiết kế đã duyệt thành các task nhỏ." },
  coding: { label: "5. Viết code & unit test", tip: "Làm lần lượt từng task." },
  e2e: { label: "6. Kiểm thử E2E", tip: "Playwright chạy trình duyệt thật, chấm theo tiêu chí nghiệm thu." },

  locate: { label: "1. Truy tìm", tip: "Lục repo mẫu tìm mọi file thuộc tính năng này: SQL, BE, FE." },
  conventions: {
    label: "2. Đọc dự án đích",
    tip: "Đọc cấu trúc dự án đích: layout module, package gốc, quy ước FE và SQL.",
  },
  mapping: {
    label: "3. Lập bảng ánh xạ",
    tip: "Quyết định từng file nguồn đi đâu trong dự án đích và phải đổi những gì.",
  },
  port: { label: "4. Port code", tip: "Ghi từng nhóm file sang dự án đích theo bảng ánh xạ." },
  coverage: {
    label: "5. Kiểm phủ",
    tip: "Đối chiếu bằng code: mỗi dòng trong bảng ánh xạ đã có file thật trên đĩa chưa.",
  },
  wiring: {
    label: "6. Kiểm nối FE↔BE",
    tip: "Đối chiếu bằng code: mọi import trong file FE vừa port có trỏ tới file thật không, và mọi API FE gọi có controller BE nào map không. Chạy cả khi bỏ qua build.",
  },
  build: { label: "7. Kiểm biên dịch", tip: "Build lại dự án đích; chỉ lỗi ở file vừa port (hoặc do chúng gây ra) mới tính là lỗi." },
  tests: {
    label: "8. Unit test",
    tip: "Viết và chạy unit test CRUD: BE (controller qua MockMvc, service với Mockito) và FE (mỗi hàm API gọi đúng URL/method của BE). Test fail → agent sửa code (không được sửa test), rồi chạy lại build + test, tối đa 2 vòng.",
  },
};

const STATUS_TEXT = {
  idle: "chưa chạy",
  running: "đang chạy",
  done: "hoàn tất",
  "escalated-specs": "dừng — thiết kế chưa được duyệt",
  "escalated-e2e": "dừng — E2E chưa đạt",
  incomplete: "chưa trọn vẹn",
  errored: "lỗi",
  stopped: "đã dừng",
  unknown: "không rõ",
};

const STATUS_BADGE = {
  done: "Hoàn tất",
  "escalated-specs": "Chưa duyệt",
  "escalated-e2e": "E2E chưa đạt",
  incomplete: "Chưa trọn vẹn",
  errored: "Lỗi",
  stopped: "Đã dừng",
  "in-progress": "Đang dở",
  unknown: "Không rõ",
};

const NEXT_STEPS = {
  done: "E2E đã đạt. Bước tiếp theo: mở thư mục dự án, chạy <code>git diff</code> để xem AI đã sửa gì, tự review rồi commit.",
  "escalated-specs":
    "Qua 3 lần mà bên duyệt vẫn từ chối thiết kế. Code <strong>chưa bị đụng tới</strong>. Tiến độ thiết kế đã lưu: bấm Chạy lại với cùng spec sẽ <strong>sửa tiếp từ bản thiết kế cuối</strong> theo phản hồi (thêm 3 lượt), không làm lại từ đầu. Nếu phản hồi cho thấy spec còn mơ hồ, sửa spec rồi chạy — khi đó thiết kế làm lại từ đầu.",
  "escalated-e2e":
    "E2E chưa đạt — hệ thống <strong>dừng ngay, không tự code lại từ task đầu</strong>. Code đã viết <strong>vẫn nằm trên đĩa, không bị hoàn tác</strong>. Bước tiếp theo: xem kết quả bên dưới để biết kịch bản/tiêu chí nào trượt, sửa (hoặc làm rõ spec) rồi chạy lại — tiến độ đã lưu, chạy lại sẽ vào thẳng bước E2E.",
  incomplete:
    "Còn thiếu: hoặc có file trong bảng ánh xạ chưa được ghi ra, hoặc dự án đích build không qua. Code đã port <strong>vẫn nằm trên đĩa</strong>. Mở báo cáo xem danh sách thiếu và lỗi biên dịch, rồi hoàn thiện nốt.",
  errored:
    "Pipeline dừng giữa chừng và <strong>không tự chạy lại</strong>. Kết quả bên dưới nói rõ dừng ở giai đoạn/task nào và vì sao (ví dụ <code>rate_limit</code> — chờ hạn mức tài khoản reset rồi chạy lại). Tiến độ đã lưu: bấm Chạy lại với cùng spec sẽ <strong>tiếp tục từ chỗ dừng</strong>, bỏ qua thiết kế và các task đã xong.",
  stopped:
    "Anh đã bấm Dừng. Các file AI đã ghi vào dự án <strong>không bị hoàn tác</strong> — kiểm tra bằng <code>git status</code> trong thư mục dự án. Bấm Chạy lại với cùng spec sẽ tiếp tục từ task đang dở; tick \"Chạy lại từ đầu\" nếu muốn làm lại sạch.",
};

const RUN_ERROR_TEXT = {
  busy: () => "Đang có một lần chạy khác. Bấm Dừng để kết thúc nó trước khi chạy lần mới.",
  "spec-not-found": (detail) => `Không tìm thấy file spec: ${detail}`,
  "project-not-found": (detail) => `Không tìm thấy thư mục dự án: ${detail}`,
  "schema-not-found": (detail) => `Không tìm thấy file schema: ${detail}`,
  "reference-not-found": (detail) => `Không tìm thấy thư mục repo mẫu: ${detail}`,
  "reference-required": () => "Chế độ clone bắt buộc phải có repo mẫu.",
  "what-required": () => "Nhập tên tính năng cần clone.",
  "db-connection-required": () => "Anh chọn “đã có database sẵn” thì phải nhập chuỗi kết nối.",
};

const SPEC_TEMPLATE = `# Tên tính năng

## Bối cảnh
Màn hình / API nào, thuộc module nào, hiện đã có sẵn cái gì liên quan.

## Yêu cầu
- Yêu cầu 1, mô tả bằng hành vi quan sát được.
- Yêu cầu 2.

## Ràng buộc
- Quy ước đặt tên, phân tầng, thư viện bắt buộc dùng của dự án.

## Tiêu chí nghiệm thu
- [ ] Người dùng bấm X thì thấy Y.
- [ ] Nhập sai định dạng thì hiện thông báo Z.
`;

let appConfig = null;
let stagesByMode = { feature: [], clone: [] };
/** Which form the user is filling in — not necessarily what is running. */
let formMode = "feature";
let lines = [];
let currentRunId = null;
let lastSeq = 0;
let runState = null;

// --- HTTP ------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `${response.status} ${response.statusText}`);
    error.code = data.code;
    error.detail = data.detail;
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// --- Tabs ------------------------------------------------------------------

el.tabs.addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (button) showTab(button.dataset.tab);
});

// Any "xem hướng dẫn" link anywhere on the page.
document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-goto]");
  if (!link) return;
  event.preventDefault();
  showTab(link.dataset.goto);
});

function showTab(name) {
  for (const tab of el.tabs.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".panel-group")) {
    panel.classList.toggle("is-active", panel.id === `tab-${name}`);
  }
  document.querySelector("main").scrollTop = 0;
  if (name === "history") loadRuns();
}

// --- Quick start callout ---------------------------------------------------

const QUICKSTART_KEY = "aidev-ui-quickstart-hidden";

if (localStorage.getItem(QUICKSTART_KEY) === "1") el.quickstart.classList.add("hidden");

$("quickstart-hide").addEventListener("click", () => {
  el.quickstart.classList.add("hidden");
  localStorage.setItem(QUICKSTART_KEY, "1");
});

// --- Form state ------------------------------------------------------------

const STORAGE_KEY = "aidev-ui-form";

function saveForm() {
  // The connection string is deliberately absent: it can carry a password and
  // localStorage survives the run, the tab and the browser restart.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      projectBe: el.projectBe.value,
      projectFe: el.projectFe.value,
      specPath: el.specPath.value,
      referencePath: el.referencePath.value,
      cloneWhat: el.cloneWhat.value,
      cloneFromBe: el.cloneFromBe.value,
      cloneFromFe: el.cloneFromFe.value,
      dbMode: el.dbMode.value,
      dbSchemaPath: el.dbSchemaPath.value,
    }),
  );
}

function restoreForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    // A form saved before separate BE/FE folders had one project folder: put
    // it in both boxes, which the server treats as one project — same as before.
    el.projectBe.value = saved.projectBe ?? saved.projectPath ?? "";
    el.projectFe.value = saved.projectFe ?? saved.projectPath ?? "";
    el.specPath.value = saved.specPath || "";
    el.referencePath.value = saved.referencePath || "";
    el.cloneWhat.value = saved.cloneWhat || "";
    el.cloneFromBe.value = saved.cloneFromBe ?? saved.cloneFrom ?? "";
    el.cloneFromFe.value = saved.cloneFromFe ?? saved.cloneFrom ?? "";
    el.dbMode.value = saved.dbMode || "none";
    el.dbSchemaPath.value = saved.dbSchemaPath || "";
  } catch {
    // Unreadable storage is not worth failing the page over.
  }
  syncDbMode();
  setMode(localStorage.getItem(MODE_KEY) || "feature");
}

const MODE_KEY = "aidev-ui-mode";

el.modeSwitch.addEventListener("click", (event) => {
  const button = event.target.closest(".mode-btn");
  if (button) setMode(button.dataset.mode);
});

function setMode(mode) {
  formMode = mode === "clone" ? "clone" : "feature";
  localStorage.setItem(MODE_KEY, formMode);

  for (const button of el.modeSwitch.querySelectorAll(".mode-btn")) {
    button.classList.toggle("is-active", button.dataset.mode === formMode);
  }
  for (const card of document.querySelectorAll(".mode-only-feature")) {
    card.classList.toggle("hidden", formMode !== "feature");
  }
  for (const card of document.querySelectorAll(".mode-only-clone")) {
    card.classList.toggle("hidden", formMode !== "clone");
  }
  // Clone mode has no database step, so the run card is step 3 there.
  el.stepRunNum.textContent = formMode === "clone" ? "3" : "4";

  // Show the strip for the mode being filled in while nothing is running.
  renderStages(runState ?? { stage: null, completedStages: [], setback: false, mode: formMode });
  syncRunButton();
}

function syncDbMode() {
  const mode = el.dbMode.value;
  el.dbConnectionRow.classList.toggle("hidden", mode !== "connection");
  el.dbConnectionHint.classList.toggle("hidden", mode !== "connection");
  el.dbSchemaRow.classList.toggle("hidden", mode !== "schema-file");
}

/**
 * The Run button stays disabled until the inputs are filled and the
 * commit/stash box is ticked. The tick is asked for every run on purpose:
 * the pipeline overwrites a working tree with no backup, so this is the one
 * piece of friction worth keeping.
 */
function syncRunButton(running = el.runStop.disabled === false) {
  const inputsFilled =
    formMode === "clone"
      ? el.cloneWhat.value.trim() && (el.cloneFromBe.value.trim() || el.cloneFromFe.value.trim())
      : el.specPath.value.trim();
  const hasTarget = el.projectBe.value.trim() || el.projectFe.value.trim();
  const ready = hasTarget && inputsFilled && el.precheck.checked && !running;

  el.runStart.disabled = !ready;
  el.runStart.textContent = formMode === "clone" ? "▶ Chạy clone" : "▶ Chạy pipeline";
  el.runStart.title = ready
    ? "Bắt đầu chạy"
    : running
      ? "Đang có một lần chạy"
      : formMode === "clone"
        ? "Điền thư mục BE/FE đích, từ khoá tính năng, repo mẫu (BE/FE) và tick ô xác nhận"
        : "Điền thư mục BE/FE, file spec và tick ô xác nhận ở trên";
}

el.dbMode.addEventListener("change", () => {
  syncDbMode();
  saveForm();
});

for (const input of [
  el.projectBe,
  el.projectFe,
  el.specPath,
  el.referencePath,
  el.cloneWhat,
  el.cloneFromBe,
  el.cloneFromFe,
  el.dbSchemaPath,
]) {
  input.addEventListener("input", () => syncRunButton());
  input.addEventListener("change", saveForm);
}

el.precheck.addEventListener("change", () => syncRunButton());

el.dbReveal.addEventListener("click", () => {
  const hidden = el.dbConnection.type === "password";
  el.dbConnection.type = hidden ? "text" : "password";
  el.dbReveal.textContent = hidden ? "Ẩn" : "Hiện";
});

// --- Presets ---------------------------------------------------------------

let presets = [];

async function loadPresets() {
  presets = (await api("/api/presets")).presets;
  renderPresets();
}

function renderPresets() {
  el.presetSelect.innerHTML = '<option value="">— Chọn —</option>';
  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    el.presetSelect.append(option);
  }
}

el.presetSelect.addEventListener("change", () => {
  const preset = presets.find((p) => p.id === el.presetSelect.value);
  if (!preset) return;
  // Older presets hold one project folder; it goes in both boxes (one project).
  el.projectBe.value = preset.projectBe || preset.projectPath || "";
  el.projectFe.value = preset.projectFe || preset.projectPath || "";
  el.specPath.value = preset.specPath;
  el.referencePath.value = preset.referencePath || "";
  el.dbMode.value = preset.dbMode || "none";
  el.dbSchemaPath.value = preset.dbSchemaPath || "";
  syncDbMode();
  syncRunButton();
  saveForm();
});

$("preset-save").addEventListener("click", async () => {
  const suggestion =
    (el.projectBe.value || el.projectFe.value).split(/[\\/]/).filter(Boolean).pop() || "thiet-lap";
  const name = prompt("Đặt tên cho bộ thiết lập này", suggestion);
  if (!name) return;
  presets = (
    await api("/api/presets", {
      method: "POST",
      body: JSON.stringify({
        name,
        projectBe: el.projectBe.value,
        projectFe: el.projectFe.value,
        specPath: el.specPath.value,
        referencePath: el.referencePath.value,
        dbMode: el.dbMode.value,
        dbSchemaPath: el.dbSchemaPath.value,
      }),
    })
  ).presets;
  renderPresets();
  el.presetSelect.value = presets.find((p) => p.name === name)?.id ?? "";
});

$("preset-delete").addEventListener("click", async () => {
  const id = el.presetSelect.value;
  if (!id) return;
  presets = (await api("/api/presets/delete", { method: "POST", body: JSON.stringify({ id }) })).presets;
  renderPresets();
});

// --- Picker ----------------------------------------------------------------

let pickerResolve = null;
let pickerMode = "dir";
let pickerKind = "any";

function openPicker({ mode, title, kind, startPath }) {
  pickerMode = mode;
  el.pickerTitle.textContent = title;
  el.pickerChoose.classList.toggle("hidden", mode !== "dir");
  el.picker.classList.remove("hidden");
  el.pickerError.textContent = "";
  navigatePicker(startPath || "", kind);
  return new Promise((resolve) => {
    pickerResolve = resolve;
  });
}

function closePicker(value) {
  el.picker.classList.add("hidden");
  pickerResolve?.(value ?? null);
  pickerResolve = null;
}

async function navigatePicker(target, kind = pickerKind) {
  pickerKind = kind;
  try {
    const result = await api(`/api/browse?path=${encodeURIComponent(target)}&kind=${kind}`);
    el.pickerPath.value = result.path;
    el.pickerPath.dataset.parent = result.parent ?? "";
    el.pickerError.textContent = "";
    el.pickerList.innerHTML = "";
    for (const entry of result.entries) {
      const item = document.createElement("li");
      item.className = "picker-item";
      item.dataset.type = entry.type;
      item.dataset.path = entry.path;
      item.innerHTML = `<span class="icon">${entry.type === "dir" ? "📁" : "📄"}</span><span>${escapeHtml(entry.name)}</span>`;
      el.pickerList.append(item);
    }
    if (!result.entries.length) {
      el.pickerList.innerHTML =
        '<li class="picker-item"><span class="icon">—</span><span>Thư mục rỗng</span></li>';
    }
  } catch (error) {
    el.pickerError.textContent = error.message;
  }
}

el.pickerList.addEventListener("click", (event) => {
  const item = event.target.closest(".picker-item[data-path]");
  if (!item) return;
  if (item.dataset.type === "dir") navigatePicker(item.dataset.path);
  else if (pickerMode === "file") closePicker(item.dataset.path);
});

$("picker-up").addEventListener("click", () => navigatePicker(el.pickerPath.dataset.parent ?? ""));
$("picker-go").addEventListener("click", () => navigatePicker(el.pickerPath.value));
$("picker-close").addEventListener("click", () => closePicker(null));
el.pickerChoose.addEventListener("click", () => closePicker(el.pickerPath.value));
el.picker.addEventListener("click", (event) => {
  if (event.target === el.picker) closePicker(null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.picker.classList.contains("hidden")) closePicker(null);
});

const FOLDER_FIELDS = {
  "project-be": { field: "projectBe", sibling: "projectFe", title: "Chọn thư mục BE của dự án đích" },
  "project-fe": { field: "projectFe", sibling: "projectBe", title: "Chọn thư mục FE của dự án đích" },
  "clone-from-be": { field: "cloneFromBe", sibling: "cloneFromFe", title: "Chọn thư mục BE của repo mẫu (chỉ đọc)" },
  "clone-from-fe": { field: "cloneFromFe", sibling: "cloneFromBe", title: "Chọn thư mục FE của repo mẫu (chỉ đọc)" },
};

for (const button of document.querySelectorAll("[data-browse]")) {
  button.addEventListener("click", async () => {
    const what = button.dataset.browse;

    // The four BE/FE folder boxes all pick a directory the same way.
    const folderField = FOLDER_FIELDS[what];
    if (folderField) {
      const field = el[folderField.field];
      const chosen = await openPicker({
        mode: "dir",
        kind: "dir",
        title: folderField.title,
        // Start next to whichever folder is already filled in: BE and FE usually sit side by side.
        startPath: field.value || el[folderField.sibling].value,
      });
      if (chosen) {
        field.value = chosen;
        saveForm();
        syncRunButton();
      }
      return;
    }

    if (what === "spec" || what === "spec-open") {
      const field = what === "spec" ? el.specPath : el.specFilePath;
      const chosen = await openPicker({
        mode: "file",
        kind: "markdown",
        title: "Chọn file spec (.md)",
        startPath: parentOf(field.value) || appConfig?.specsDir,
      });
      if (chosen) {
        field.value = chosen;
        saveForm();
        syncRunButton();
        if (what === "spec-open") loadSpecFile(chosen);
      }
      return;
    }

    if (what === "reference") {
      const chosen = await openPicker({
        mode: "dir",
        kind: "dir",
        title: "Chọn repo mẫu để tham chiếu (chỉ đọc)",
        startPath: el.referencePath.value,
      });
      if (chosen) {
        el.referencePath.value = chosen;
        saveForm();
      }
      return;
    }

    if (what === "schema") {
      const chosen = await openPicker({
        mode: "file",
        kind: "markdown",
        title: "Chọn file schema",
        startPath: parentOf(el.dbSchemaPath.value),
      });
      if (chosen) {
        el.dbSchemaPath.value = chosen;
        saveForm();
      }
    }
  });
}

function parentOf(filePath) {
  if (!filePath) return "";
  const at = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return at === -1 ? "" : filePath.slice(0, at);
}

// --- Run control -----------------------------------------------------------

el.runStart.addEventListener("click", async () => {
  el.runError.classList.add("hidden");
  try {
    await api("/api/run", { method: "POST", body: JSON.stringify(runBody()) });
    saveForm();
    // A one-off choice: the next Run should resume again unless asked otherwise.
    $("run-fresh").checked = false;
  } catch (error) {
    showRunError(error);
  }
});

/**
 * The two modes send different fields. Built here rather than at the click so
 * the shape of each request is readable in one place.
 */
function runBody() {
  const noMetadataStandards = el.metadataStandardsMode.value === "skip";
  if (formMode === "clone") {
    return {
      mode: "clone",
      projectBePath: el.projectBe.value,
      projectFePath: el.projectFe.value,
      what: el.cloneWhat.value,
      referenceBePath: el.cloneFromBe.value,
      referenceFePath: el.cloneFromFe.value,
      skipBuild: el.cloneSkipBuild.checked,
      skipTests: el.cloneSkipTests.checked,
      fresh: $("run-fresh").checked,
      noMetadataStandards,
    };
  }
  return {
    mode: "feature",
    projectBePath: el.projectBe.value,
    projectFePath: el.projectFe.value,
    specPath: el.specPath.value,
    referencePaths: el.referencePath.value.trim() ? [el.referencePath.value.trim()] : [],
    dbMode: el.dbMode.value,
    dbConnection: el.dbConnection.value,
    dbSchemaPath: el.dbSchemaPath.value,
    fresh: $("run-fresh").checked,
    noMetadataStandards,
  };
}

function showRunError(error) {
  const translate = RUN_ERROR_TEXT[error.code];
  el.runError.textContent = translate ? translate(error.detail ?? "") : error.message;
  el.runError.classList.remove("hidden");
}

el.runStop.addEventListener("click", async () => {
  if (!confirm("Dừng lần chạy này? Các file AI đã ghi vào dự án sẽ không được hoàn tác.")) return;
  el.runStop.disabled = true;
  await api("/api/stop", { method: "POST" }).catch(() => {});
});

function renderState(state) {
  runState = state;
  const running = state.status === "running";

  el.statusPill.textContent = STATUS_TEXT[state.status] ?? state.status;
  el.statusPill.dataset.status = state.status;
  el.runStop.disabled = !running;
  syncRunButton(running);
  if (running) el.runError.classList.add("hidden");

  if (state.startedAt) {
    const started = new Date(state.startedAt).toLocaleTimeString("vi-VN");
    const tasks = state.taskCount !== null ? ` · ${state.taskCount} task` : "";
    const took = state.finishedAt
      ? ` · mất ${formatDuration(Date.parse(state.finishedAt) - Date.parse(state.startedAt))}`
      : "";
    const spent = state.usage && usageTokens(state.usage) ? ` · ${describeUsage(state.usage, true)}` : "";
    el.runMeta.textContent = `Bắt đầu ${started}${tasks}${took}${spent}`;
  } else {
    el.runMeta.textContent = "";
  }

  renderStages(state);
  renderResult(state);
}

function renderStages(state) {
  el.stages.innerHTML = "";
  // While idle, show the strip for the mode being filled in; once a run
  // starts, show the strip for the pipeline that is actually running.
  const mode = state.status === "running" || state.stage ? (state.mode ?? formMode) : formMode;
  for (const id of stagesByMode[mode] ?? []) {
    const text = STAGE_TEXT[id] ?? { label: id, tip: "" };
    const isCurrent = state.stage === id;
    const item = document.createElement("li");
    item.className = "stage";
    item.title = text.tip;
    item.dataset.state = isCurrent
      ? state.setback
        ? "setback"
        : "active"
      : state.completedStages.includes(id)
        ? "done"
        : "pending";
    const spent = state.stageUsage?.[id];
    if (spent && usageTokens(spent)) item.title = `${text.tip}\n\nĐã tiêu: ${describeUsage(spent, true)}`.trim();
    item.innerHTML = `<div class="stage-label">${escapeHtml(text.label)}</div><div class="stage-detail">${
      isCurrent && state.stageDetail ? escapeHtml(state.stageDetail) : ""
    }</div><div class="stage-tokens">${spent && usageTokens(spent) ? escapeHtml(describeUsage(spent)) : ""}</div>`;
    el.stages.append(item);
  }
}

/** Every token moved, cached or not — the figure the run is charged against. */
function usageTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

function compactNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** "1.2M token · ~$0.42"; detailed adds the input/output/cache split. */
function describeUsage(usage, detailed = false) {
  const base = `${compactNumber(usageTokens(usage))} token · ~$${usage.costUsd.toFixed(2)}`;
  if (!detailed) return base;
  const cache = usage.cacheReadTokens + usage.cacheCreationTokens;
  return `${base} (vào ${compactNumber(usage.inputTokens)}, ra ${compactNumber(usage.outputTokens)}, cache ${compactNumber(cache)})`;
}

function renderResult(state) {
  if (!state.finalMessage) {
    el.result.classList.add("hidden");
    el.result.innerHTML = "";
    return;
  }

  const guidance = NEXT_STEPS[state.status] ?? "";
  const report = state.logRunId
    ? `<p class="result-report">Báo cáo đầy đủ: <a href="#" data-run="${escapeHtml(state.logRunId)}">${escapeHtml(state.logRunId)}</a></p>`
    : "";

  el.result.dataset.status = state.status;
  el.result.classList.remove("hidden");
  el.result.innerHTML = `
    <div class="result-title">${escapeHtml(STATUS_TEXT[state.status] ?? state.status)}</div>
    ${guidance ? `<p class="result-guidance">${guidance}</p>` : ""}
    <details class="result-raw">
      <summary>Nguyên văn pipeline báo về</summary>
      <pre>${escapeHtml(state.finalMessage)}</pre>
    </details>
    ${report}`;
}

el.result.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-run]");
  if (!link) return;
  event.preventDefault();
  showTab("history");
  loadRuns().then(() => selectRun(link.dataset.run));
});

// --- Log -------------------------------------------------------------------

function renderLog() {
  el.log.innerHTML = "";
  const visible = lines.filter(passesLogFilter);
  if (!visible.length) {
    el.log.innerHTML = '<div class="log-empty">Chưa có dòng nào.</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const line of visible) fragment.append(logNode(line));
  el.log.append(fragment);
  scrollLog();
}

function appendLine(line) {
  if (!passesLogFilter(line)) return;
  el.log.querySelector(".log-empty")?.remove();
  el.log.append(logNode(line));
  scrollLog();
}

function passesLogFilter(line) {
  return !el.logOnlyProgress.checked || line.kind === "progress" || line.kind === "system";
}

function logNode(line) {
  const node = document.createElement("div");
  node.className = "log-line";
  node.dataset.kind = line.kind;
  node.innerHTML = `<span class="ts">${new Date(line.at).toLocaleTimeString("vi-VN")}</span><span class="txt">${escapeHtml(line.text)}</span>`;
  return node;
}

function scrollLog() {
  if (el.logFollow.checked) el.log.scrollTop = el.log.scrollHeight;
}

el.logOnlyProgress.addEventListener("change", renderLog);

$("log-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(lines.map((line) => line.text).join("\n"));
  const button = $("log-copy");
  button.textContent = "Đã chép";
  setTimeout(() => (button.textContent = "Sao chép"), 1200);
});

// --- Live stream -----------------------------------------------------------

function connectStream() {
  const source = new EventSource("/api/stream");
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);

    if (event.type === "state") {
      // A new run resets the sequence, and a reconnect replays the buffer —
      // keying on the run id keeps both cases from duplicating or dropping.
      if (event.state.id !== currentRunId) {
        currentRunId = event.state.id;
        lines = [];
        lastSeq = 0;
        renderLog();
      }
      renderState(event.state);
      return;
    }

    if (event.type === "line") {
      if (event.line.seq <= lastSeq) return;
      lastSeq = event.line.seq;
      lines.push(event.line);
      appendLine(event.line);
    }
  };
}

// --- Spec editor -----------------------------------------------------------

async function loadSpecFile(target) {
  try {
    const data = await api(`/api/spec?path=${encodeURIComponent(target)}`);
    el.specFilePath.value = data.path;
    el.specEditor.value = data.content;
    el.specStatus.textContent = `Đã mở ${data.path}`;
  } catch (error) {
    el.specStatus.textContent = error.message;
  }
}

async function saveSpecFile() {
  const target = el.specFilePath.value.trim();
  if (!target) {
    el.specStatus.textContent = "Nhập đường dẫn lưu file trước đã.";
    return null;
  }
  const data = await api("/api/spec", {
    method: "POST",
    body: JSON.stringify({ path: target, content: el.specEditor.value }),
  });
  el.specFilePath.value = data.path;
  el.specStatus.textContent = `Đã lưu ${data.path} lúc ${new Date().toLocaleTimeString("vi-VN")}`;
  return data.path;
}

$("spec-save").addEventListener("click", () => {
  saveSpecFile().catch((error) => (el.specStatus.textContent = error.message));
});

$("spec-template").addEventListener("click", () => {
  if (el.specEditor.value.trim() && !confirm("Ghi đè nội dung đang soạn bằng mẫu?")) return;
  el.specEditor.value = SPEC_TEMPLATE;
  el.specStatus.textContent = "Đã chèn mẫu — sửa lại theo tính năng của anh rồi bấm Lưu.";
});

$("spec-use").addEventListener("click", async () => {
  try {
    const saved = await saveSpecFile();
    if (!saved) return;
    el.specPath.value = saved;
    saveForm();
    syncRunButton();
    showTab("run");
  } catch (error) {
    el.specStatus.textContent = error.message;
  }
});

$("spec-edit").addEventListener("click", () => {
  showTab("spec");
  const current = el.specPath.value.trim();
  if (current) {
    loadSpecFile(current);
  } else {
    el.specFilePath.value = defaultSpecPath();
    if (!el.specEditor.value.trim()) el.specEditor.value = SPEC_TEMPLATE;
  }
});

function defaultSpecPath() {
  if (!appConfig) return "";
  const stamp = new Date().toISOString().slice(0, 10);
  const separator = appConfig.platform === "win32" ? "\\" : "/";
  return `${appConfig.specsDir}${separator}${stamp}-tinh-nang-moi.md`;
}

// --- History ---------------------------------------------------------------

async function loadRuns() {
  const runs = (await api("/api/runs")).runs;
  el.runList.innerHTML = "";
  if (!runs.length) {
    el.runList.innerHTML =
      '<li class="hint">Chưa có lần chạy nào được ghi lại trong thư mục <code>runs/</code>.</li>';
    return;
  }
  for (const run of runs) {
    const item = document.createElement("li");
    item.className = "run-item";
    item.dataset.id = run.id;
    item.innerHTML = `
      <div class="run-item-top">
        <span class="run-item-name">${escapeHtml(run.specName ?? run.id)}</span>
        <span class="badge" data-status="${escapeHtml(run.status)}">${escapeHtml(
          STATUS_BADGE[run.status] ?? run.status,
        )}</span>
        <button class="run-item-delete" data-delete-run="${escapeHtml(run.id)}" title="Xóa lần chạy này">✕</button>
      </div>
      <div class="run-item-meta">${escapeHtml(run.projectName ?? "—")} · ${
        run.startedAt ? new Date(run.startedAt).toLocaleString("vi-VN") : "không rõ thời gian"
      }${run.durationMs !== null ? ` · ${formatDuration(run.durationMs)}` : ""}${
        run.usage ? ` · ${escapeHtml(describeUsage(run.usage))}` : ""
      }</div>`;
    el.runList.append(item);
  }
}

el.runList.addEventListener("click", async (event) => {
  const deleteId = event.target.closest("[data-delete-run]")?.dataset.deleteRun;
  if (deleteId) {
    if (!confirm("Xóa lần chạy này? Không thể hoàn tác.")) return;
    await api("/api/runs/delete", { method: "POST", body: JSON.stringify({ id: deleteId }) });
    if (el.runList.querySelector(".run-item.is-active")?.dataset.id === deleteId) {
      el.reportTitle.textContent = "Báo cáo";
      el.report.innerHTML = '<p class="hint">Chọn một lần chạy ở cột bên trái để xem báo cáo đầy đủ.</p>';
    }
    await loadRuns();
    return;
  }
  const item = event.target.closest(".run-item");
  if (item) selectRun(item.dataset.id);
});

$("runs-refresh").addEventListener("click", loadRuns);

$("runs-clear").addEventListener("click", async () => {
  if (!confirm("Xóa TOÀN BỘ lịch sử chạy? Không thể hoàn tác.")) return;
  await api("/api/runs/clear", { method: "POST" });
  el.reportTitle.textContent = "Báo cáo";
  el.report.innerHTML = '<p class="hint">Chọn một lần chạy ở cột bên trái để xem báo cáo đầy đủ.</p>';
  await loadRuns();
});

async function selectRun(id) {
  for (const item of el.runList.querySelectorAll(".run-item")) {
    item.classList.toggle("is-active", item.dataset.id === id);
  }
  try {
    const { run } = await api(`/api/run-detail?id=${encodeURIComponent(id)}`);
    el.reportTitle.textContent = run.specName ?? run.id;
    el.report.innerHTML = renderMarkdown(run.report);
    el.report.scrollTop = 0;
  } catch (error) {
    el.report.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
  }
}

/**
 * Just enough Markdown for the report RunLogger writes: headings, lists,
 * checkbox lists, fenced code, bold and inline code. Anything else renders as
 * the plain text it already is — a full parser would be a dependency this page
 * does not otherwise need.
 */
function renderMarkdown(markdown) {
  const out = [];
  let inCode = false;
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of String(markdown).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");

    if (line.startsWith("```")) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(rawLine)}\n`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }

    const listItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(listItem[1]);
      out.push(
        checkbox
          ? `<li>${checkbox[1].toLowerCase() === "x" ? "✅" : "⬜"} ${inline(checkbox[2])}</li>`
          : `<li>${inline(listItem[1])}</li>`,
      );
      continue;
    }

    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// --- Misc ------------------------------------------------------------------

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} giây`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)} phút ${totalSeconds % 60} giây`;
}

async function init() {
  appConfig = await api("/api/config");
  stagesByMode = appConfig.stages;

  const { apiKey, oauthToken } = appConfig.credentials;
  const credentialText = apiKey
    ? "đang dùng ANTHROPIC_API_KEY"
    : oauthToken
      ? "đang dùng CLAUDE_CODE_OAUTH_TOKEN"
      : "chưa có credential trong .env";
  el.topbarMeta.innerHTML = `
    <span>Model: ${escapeHtml(appConfig.model)}</span>
    <span class="${apiKey || oauthToken ? "good" : "bad"}">${escapeHtml(credentialText)}</span>
    <span title="Thư mục cài đặt aidev">${escapeHtml(appConfig.repoRoot)}</span>`;

  restoreForm();
  el.specFilePath.value = defaultSpecPath();

  const initial = await api("/api/state");
  currentRunId = initial.state.id;
  lines = initial.lines;
  lastSeq = lines.at(-1)?.seq ?? 0;
  renderState(initial.state);
  renderLog();

  await loadPresets();
  connectStream();
}

init().catch((error) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div class="callout callout-error"><div class="callout-body">Không kết nối được tới máy chủ aidev UI: ${escapeHtml(
      error.message,
    )}. Kiểm tra xem cửa sổ chạy <code>aidev ui</code> còn mở không.</div></div>`,
  );
});
