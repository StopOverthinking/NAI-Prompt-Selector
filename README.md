# NAI-Prompt-Selector

NovelAI 이미지 페이지(`https://novelai.net/image`)에서 작동하는 Chrome Manifest V3 확장프로그램입니다.

## 포함된 기능

- NAIToolbar 기반 자동 생성
  - 1회 생성
  - 반복 자동 생성
  - 생성 간격과 목표 횟수
  - 자동 생성 완료 알림
  - 최근 생성 이미지 강조
  - 선택적 자동 저장
- PromptSelector 기반 프롬프트 패널
  - `[Group]` 형식의 그룹 정의
  - 프롬프트 칩 선택
  - 그룹별 전체 선택/해제
  - `Ctrl + wheel` 가중치 조절(-3 ~ +3)
  - Base Prompt에서 선행 프롬프트 선택 / Quick Prompt / 후행 프롬프트 선택 순서로 병합
  - 미리보기와 복사
  - Base Prompt / Undesired Content / Character Prompt / Character Undesired Content 슬롯별 편집
  - 현재 NovelAI 페이지의 캐릭터 추가/삭제 상태를 감지해 슬롯 목록 갱신
  - 현재 슬롯만 적용하거나 모든 현재 슬롯을 한 번에 적용
  - NovelAI 캐릭터 추가, 삭제, 순서 변경
  - 캐릭터 순서 변경 시 Prompt / Undesired Content 슬롯 쌍을 함께 이동
- 자동 생성 설정
  - popup 또는 페이지 패널에서 목표 횟수와 생성 주기 설정
- NovelAI 강조 문법
  - 기본 가중치: `1girl`
  - 강조/약화: `1.5::1girl::`

## 로드 방법

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. "압축해제된 확장 프로그램을 로드"를 누릅니다.
4. 이 저장소 폴더(`NAI-Prompt-Selector`)를 선택합니다.

## 검증

```powershell
node --check prompt-core.js
node --check content.js
node --check background.js
node --check popup\popup.js
node tests\prompt-core.test.js
```
