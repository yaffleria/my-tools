import { SignaturePad, type SignaturePadHandle } from '@my-tools/mobile-web';
import { useRef, useState } from 'react';
import { Page } from '../components/Page';

export function SignaturePage() {
  const padRef = useRef<SignaturePadHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [png, setPng] = useState<string | null>(null);

  return (
    <Page
      title="전자서명"
      summary="체크인 마지막 단계의 서명 패드입니다. 손가락으로 그려 보세요."
      points={[
        'Pointer Events 하나로 마우스·터치·펜을 같이 처리한다.',
        'touch-action: none으로 서명하는 동안 스크롤·확대·당겨서 새로고침을 막는다.',
        'devicePixelRatio만큼 캔버스 해상도를 키워 레티나에서 선이 흐려지지 않게 한다.',
        '모바일은 주소창이 접힐 때 resize가 난다. 크기가 실제로 바뀔 때만 다시 맞추고 기존 서명을 복원한다.',
        '부모는 ref 핸들(clear, isEmpty, toBlob)로 제어한다. 빈 서명은 제출을 막는다.',
      ]}
      source={[
        { label: 'SignaturePad', path: 'packages/mobile-web/src/SignaturePad.tsx' },
        { label: '이 페이지', path: 'apps/web/src/pages/SignaturePage.tsx' },
      ]}
    >
      <div className="stack">
        <SignaturePad ref={padRef} className="signature" color="#111" onEmptyChange={setEmpty} aria-label="서명 영역" />
        <div className="row">
          <button
            type="button"
            onClick={() => {
              padRef.current?.clear();
              setPng(null);
            }}
          >
            다시 쓰기
          </button>
          <button type="button" disabled={empty} onClick={() => setPng(padRef.current?.toDataURL() ?? null)}>
            서명 완료
          </button>
        </div>
        {empty && <p className="muted">손가락이나 마우스로 서명해 주세요.</p>}
        {png && (
          <>
            <p className="muted">내보낸 PNG. 서버로 보내지 않아요.</p>
            <img className="signature-result" src={png} alt="내보낸 서명" />
          </>
        )}
      </div>
    </Page>
  );
}
