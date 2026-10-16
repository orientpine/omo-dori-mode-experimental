# UI work: the owner's seven steps

The owner's guideline for any UI work (2026-10-16): a screen, a design, a dashboard, a page, an app's UI, a frontend. The owner called it "정말 중요" (really important). When the owner asks for UI work, the lane brief carries these seven steps as written below, at the top, right after the `ulw` line. Launch with `dori launch ... --ui` to put them there. When the brief reads like UI work and `--ui` is missing, launch warns `LAUNCH_UI_HINT` and puts them in anyway (directive `ui-steps` of the directive ledger, `references/directives.json`).

The block between the markers is what `dori launch --ui` inserts, byte for byte. Its wording is the owner's original, typos corrected, its meaning and strength kept. Do not shorten or soften it. Change the text only between the markers, and only on the owner's word.

<!-- ui-steps:begin -->
[UI 지침]
1) Apple HIG(https://developer.apple.com/design/human-interface-guidelines)를 mass ulw로 전부 읽고 핵심 요소 추출.
2) 우리 프로젝트 디자인을 그 관점에서 ulw explore. 애플 특유 요소는 빼고 사용자 페르소나·경험·여정에서 뽑은 보편 인터페이스 가이드라인으로 제품의 이상적 상태를 정의.
3) 제품과 이상적 상태의 차이를 가차없이 전부 나열.
4) AI slop·프론트엔드 스킬과 레퍼런스를 모두 읽고 위반사항을 전부 나열.
5) 직접 스크린샷을 찍고 ulw loop으로 기록하며 위반사항을 전부 캡처.
6) 고치고, 고쳐졌음을 확인하는 장치까지 엄격히 포함, visual QA 조건을 하나도 빠짐없이 세부 검증, ulw plan 진행.
7) 이후 형에게 묻지 않고 mass ulw loop + ulw execute로 최대 병렬·엄밀 검증, 여러 PR에 각각 before/after 포함, 형에게 전체 진행 현황을 자주 보고.
"set goal and ulw".
<!-- ui-steps:end -->

How the steps meet the other brief rules (`references/sessions.md`):

- Step 7's "형에게 묻지 않고" is the advance plan approval the brief template already gives: the lane still reports a `| question |` to cross a line in [넘으면 안 되는 선] or for a choice only the owner can make.
- "형에게 전체 진행 현황을 자주 보고" means `[REPORT]` at each milestone, as the footer says, with the before/after screenshots or PR links.
- The four fields and the eight steps of the template stay; the seven steps sit above them.
