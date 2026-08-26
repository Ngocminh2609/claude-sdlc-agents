# Pipeline run output (not backed up by git)
# Kết quả chạy pipeline (không được git backup)

Each `npm run pipeline` invocation writes a `<runId>/log.json` and
`<runId>/report.md` here (see `src/run-log.ts`) — the full transcript of
that run: proposals, review decisions, tasks, coding attempts, E2E
verdicts. It never contains secrets (`RunLogger` explicitly drops the raw
`dbInfo` value before writing). This content is gitignored — it's local run
history, not source, and can grow large over many runs.

> Mỗi lần chạy `npm run pipeline` sẽ ghi `<runId>/log.json` và
> `<runId>/report.md` vào đây (xem `src/run-log.ts`) — toàn bộ transcript
> của lần chạy đó: đề xuất, quyết định review, task, các lần coding, kết
> quả E2E. Không bao giờ chứa secret (`RunLogger` cố tình bỏ giá trị thô
> `dbInfo` trước khi ghi). Nội dung này bị `.gitignore` chặn — vì đây là
> lịch sử chạy cục bộ, không phải mã nguồn, và có thể phình to sau nhiều lần chạy.

## MANUAL STEP — moving to a new machine
## BƯỚC THỦ CÔNG — khi đổi máy tính

Nothing here is required to get the project running again. If you want to
keep past run history, copy this folder yourself (git will not do this for
you) before switching machines — same as `.claude/agent-memory/`.

> Không cần thứ gì trong này để project chạy lại được. Nếu muốn giữ lịch
> sử các lần chạy trước, hãy tự copy folder này (git sẽ không tự làm việc
> này) trước khi đổi máy — tương tự như `.claude/agent-memory/`.
