# Agent memory (not backed up by git)
# Bộ nhớ agent (không được git backup)

This directory holds Claude Code subagents' persistent working notes (e.g.
`code-reviewer/MEMORY.md`) — accumulated locally as agents work in this repo.
It's gitignored on purpose: this is scratch/working memory, not source, and
nothing in the pipeline reads it to run.

> Thư mục này chứa ghi chú làm việc lâu dài của các subagent trong Claude
> Code (vd: `code-reviewer/MEMORY.md`) — tích lũy dần trên máy khi agent
> làm việc trong repo này. Bị `.gitignore` chặn có chủ đích: đây là bộ nhớ
> nháp/làm việc, không phải mã nguồn, và pipeline không đọc nó để chạy.

## MANUAL STEP — moving to a new machine
## BƯỚC THỦ CÔNG — khi đổi máy tính

Nothing here is required to get the project running again (`npm install` +
a re-created `.env` is enough — see `.env.example`). If you want to keep the
accumulated notes anyway, copy the whole `agent-memory/` folder yourself
(zip it, USB, cloud drive — git will not do this for you) and drop it back
in at `.claude/agent-memory/` on the new machine.

> Không cần thứ gì trong này để project chạy lại được (`npm install` + tự
> tạo lại `.env` là đủ — xem `.env.example`). Nếu vẫn muốn giữ ghi chú đã
> tích lũy, hãy tự copy toàn bộ folder `agent-memory/` (nén zip, USB, cloud
> drive — git sẽ không tự làm việc này) rồi bỏ lại vào đúng vị trí
> `.claude/agent-memory/` trên máy mới.

If you skip this, agents just start with empty memory and rebuild it over
time — no functional loss, only lost history.

> Nếu bỏ qua bước này, agent chỉ đơn giản bắt đầu lại với bộ nhớ rỗng và
> tự xây dựng lại theo thời gian — không mất chức năng gì, chỉ mất lịch sử.
