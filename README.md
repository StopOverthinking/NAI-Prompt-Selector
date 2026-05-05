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
  - 프롬프트 상태 JSON 내보내기/가져오기
  - 최근 내부 백업 복구
- 자동 생성 설정
  - popup 또는 페이지 패널에서 목표 횟수와 생성 주기 설정
- 페이지 단축키
  - `Ctrl + Space`: 현재 슬롯 적용
  - `Ctrl + Shift + Space`: 전체 슬롯 적용
  - `Ctrl + Enter`: 자동 생성 실행
  - `Ctrl + Alt + Enter`: 자동 생성 취소
  - `` Ctrl + ` ``: 확장 UI 접기/펼치기
  - 텍스트 입력 중에도 페이지 단축키를 우선 처리
- NovelAI 강조 문법
  - 기본 가중치: `1girl`
  - 강조/약화: `1.5::1girl::`
- 저장 안정성
  - 현재 상태: `chrome.storage.local`의 `naiPromptSelector.selector`
  - 최근 내부 백업: `naiPromptSelector.selectorBackups`
  - 마지막 정상 상태: `naiPromptSelector.selectorLastGood`
  - 비명시적 저장이 빈 프롬프트 상태로 후퇴하면 저장을 막고 마지막 정상 상태 복구를 시도

## 로드 방법

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. "압축해제된 확장 프로그램을 로드"를 누릅니다.
4. 이 저장소 폴더(`NAI-Prompt-Selector`)를 선택합니다.

## 저장/복구 메모

Chrome의 압축해제 확장은 확장 ID별로 `chrome.storage.local`이 분리됩니다. 이전 조사에서 현재 Chrome Default 프로필에는 현재 ID `gaoaagohfcpdajlkklgdjmbjacacljll`와 이전 ID `hbfeidhlpjiojbihdplilpognahmjpoi` 저장소가 있었고, 두 저장소 모두 기본 샘플과 빈 선택 상태만 남아 있어 커스텀 프롬프트 복구 가능성이 낮았습니다.

이번 버전은 `manifest.json`의 `key`로 향후 확장 ID가 경로 변경에 흔들리지 않도록 고정합니다. 단, 이 key를 처음 적용하는 순간에는 Chrome이 새 ID로 전환할 수 있으므로, 적용 직전 기존 패널에서 `Export`로 JSON 백업을 내려받고 새로 로드한 뒤 `Import`로 복구하는 절차를 권장합니다.

패널의 `Storage Backup` 영역에서 다음 작업을 할 수 있습니다.

- `Export`: 현재 프롬프트 상태를 `NAI-Prompt-Selector` JSON 백업으로 저장
- `Import`: Export한 JSON 백업을 현재 상태로 복원
- `Restore Backup`: 브라우저 내부에 남은 최근 정상 백업 또는 마지막 정상 상태를 복구

## 검증

```powershell
node --check prompt-core.js
node --check prompt-storage.js
node --check content.js
node --check background.js
node --check popup\popup.js
node tests\prompt-core.test.js
node tests\prompt-storage.test.js
```
