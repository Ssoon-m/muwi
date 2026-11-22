# 변경 기록

## 0.1.1 (2026-11-22)

- `muwi setup`이 Codex를 건드리지 않습니다. Codex에 지침과 사용법 skill을 넣으려면 `muwi setup --codex`를 씁니다 (전에 넣었던 것은 계속 새 위치로 맞춥니다)
- `muwi open`이 연 칸의 id를 알려 줍니다
- README에 핵심만 남기고 나머지를 `docs/`로 옮겼습니다. 그래프 칸 화면을 넣었습니다
- 설치 안내를 `claude plugin install muwi --marketplace Ssoon-m/muwi` 한 줄로 바꿨습니다

## 0.1.0 (2026-11-22)

처음 버전.

- `muwi` 명령: 계획 적기와 바꾸기(`plan`, `add`, `remove`), 노드 진행(`node`), 문제 표시(`flag`), 계획 없이 진행(`skip`), 보기(`status`, `show`), 그래프 칸 열기(`open`)
- 기록: 작업마다 `plan.json`과 `events.jsonl`
- Claude Code 플러그인: 세션이 시작될 때 지침 넣기, 읽은 skill 기록, 계획을 적지 않은 세션의 파일 수정 알림, push·PR 앞에서 묻기(기본 꺼짐)
- `muwi setup`: 터미널용 명령, Herdr 앱 그래프 칸, Codex 지침과 사용법 skill
- `muwi config`: 계획 알림과 push 앞에서 묻기를 켜고 끄기
- Herdr 앱 그래프 칸: 작업 목록, elkjs로 배치한 그래프, 노드와 작업의 기록
